// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! Quick Search 资源能力（图标 & 缩略图）。
//!
//! 本模块为 Quick Search 提供快捷方式图标和图片缩略图的提取能力，
//! 由三个子模块协作完成：
//!
//! - [cache] — 内存 LRU 缓存 + 磁盘 JPEG 持久化缓存
//! - [codec] — RGBA/BGRA 色彩空间转换与 Data URL 编码
//! - [win] — Windows Shell API 封装（HICON / IShellItemImageFactory）
//!
//! # 安全机制
//!
//! 缩略图请求受白名单保护：只有最近搜索结果中出现过的路径才允许提取缩略图，
//! 过期条目（[THUMBNAIL_ALLOWLIST_TTL]）和超量条目（[THUMBNAIL_ALLOWLIST_MAX_PATHS]）
//! 会被自动淘汰，防止任意路径探测。

use super::types::QuickShortcutItem;
use log::warn;
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use cache::{
    icon_cache, lock_mutex, normalize_icon_cache_key, normalize_thumbnail_cache_key,
    read_icon_from_disk_cache, write_icon_to_disk_cache,
};
use win::{
    image_thumbnail_data_url_shell_item, is_shortcut_file, shortcut_icon_data_url_by_extension,
    shortcut_icon_data_url_fallback, shortcut_icon_data_url_shell_item,
};

/// 单次缩略图请求允许携带的最大路径数量，防止批量滥用。
const MAX_IMAGE_THUMBNAIL_PATHS_PER_REQUEST: usize = 32;
/// 白名单条目存活时间：路径超过此时长未被搜索命中即过期。
const THUMBNAIL_ALLOWLIST_TTL: Duration = Duration::from_secs(180);
/// 白名单最大容量，超出后按最早访问时间淘汰。
const THUMBNAIL_ALLOWLIST_MAX_PATHS: usize = 4096;

static IMAGE_THUMBNAIL_ALLOWLIST: OnceLock<Mutex<ThumbnailAllowlist>> = OnceLock::new();

/// 缩略图请求白名单。
///
/// 记录最近搜索结果中出现的归一化路径及其最后命中时间，
/// 用于校验缩略图请求是否来自合法搜索流程。
struct ThumbnailAllowlist {
    /// 归一化路径 → 最近一次命中时刻。
    entries: HashMap<String, Instant>,
}

impl ThumbnailAllowlist {
    fn new() -> Self {
        Self {
            entries: HashMap::new(),
        }
    }

    /// 移除超过 TTL 的过期条目。
    fn prune_expired(&mut self, now: Instant) {
        self.entries
            .retain(|_, last_seen| now.duration_since(*last_seen) <= THUMBNAIL_ALLOWLIST_TTL);
    }

    /// 超量时按最早访问时间淘汰，保证内存占用有上限。
    fn enforce_capacity(&mut self) {
        if self.entries.len() <= THUMBNAIL_ALLOWLIST_MAX_PATHS {
            return;
        }

        let mut ordered_entries = self
            .entries
            .iter()
            .map(|(path, seen_at)| (path.clone(), *seen_at))
            .collect::<Vec<_>>();
        ordered_entries.sort_unstable_by_key(|(_, seen_at)| *seen_at);

        let to_remove = ordered_entries
            .len()
            .saturating_sub(THUMBNAIL_ALLOWLIST_MAX_PATHS);
        for (path, _) in ordered_entries.into_iter().take(to_remove) {
            self.entries.remove(&path);
        }
    }
}

/// 获取全局白名单单例。
fn thumbnail_allowlist() -> &'static Mutex<ThumbnailAllowlist> {
    IMAGE_THUMBNAIL_ALLOWLIST.get_or_init(|| Mutex::new(ThumbnailAllowlist::new()))
}

/// 路径归一化：去空白 + 正斜杠转反斜杠 + 小写。
fn normalize_path(path: &str) -> String {
    path.trim().replace('/', "\\").to_lowercase()
}

/// 判断是否为 UNC 路径（\\server\share），UNC 路径不允许提取缩略图。
fn is_unc_path(path_norm: &str) -> bool {
    path_norm.starts_with(r"\\")
}

/// 将本地绝对路径规范化为真实路径。
///
/// 拒绝空路径、相对路径、UNC 路径以及 canonicalize 后变为 UNC 的情况。
fn canonicalize_local_path(path: &str) -> Option<String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return None;
    }

    let normalized_path = normalize_path(trimmed);
    if is_unc_path(&normalized_path) {
        return None;
    }

    let path_obj = Path::new(trimmed);
    if !path_obj.is_absolute() {
        return None;
    }

    let canonical_path = std::fs::canonicalize(path_obj).ok()?;
    let canonical_string = canonical_path.to_string_lossy().to_string();
    let canonical_normalized = normalize_path(&canonical_string);
    if canonical_normalized.is_empty() || is_unc_path(&canonical_normalized) {
        return None;
    }

    Some(canonical_string)
}

/// 校验缩略图请求路径是否在白名单中。
///
/// 同时用原始归一化路径和 canonicalize 后的路径查询白名单，
/// 兼容符号链接等路径不一致场景。未命中则返回 None。
fn validate_thumbnail_request_path(path: &str) -> Option<String> {
    let requested_normalized = normalize_path(path);
    if requested_normalized.is_empty() || is_unc_path(&requested_normalized) {
        return None;
    }

    let canonical_path = canonicalize_local_path(path)?;
    let canonical_normalized = normalize_path(&canonical_path);

    let mut allowlist = thumbnail_allowlist()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    // 只信任近期搜索结果，过期路径自动淘汰。
    allowlist.prune_expired(Instant::now());

    if allowlist.entries.contains_key(&requested_normalized)
        || allowlist.entries.contains_key(&canonical_normalized)
    {
        Some(canonical_path)
    } else {
        None
    }
}

/// 记录本次搜索命中的路径到白名单。
///
/// 将搜索结果中的每条路径归一化后写入白名单，并刷新其时间戳。
/// 随后执行过期清理和容量淘汰，保证白名单不会无限增长。
pub(super) fn remember_search_paths(items: &[QuickShortcutItem]) {
    let mut allowlist = thumbnail_allowlist()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let now = Instant::now();
    allowlist.prune_expired(now);

    for item in items {
        let normalized_path = normalize_path(&item.path);
        if normalized_path.is_empty() || is_unc_path(&normalized_path) {
            continue;
        }
        allowlist.entries.insert(normalized_path, now);
    }

    allowlist.enforce_capacity();
}

/// 获取单个路径的图标 Data URL。
///
/// 查找顺序：内存 LRU → 磁盘缓存 → Windows Shell 提取。
/// 提取策略按文件类型分两路：
/// - .lnk 快捷方式：SHGetFileInfo 快速路径优先，大尺寸回退到 IShellItemImageFactory。
/// - 普通文件：先按扩展名查系统图标，失败再用 SHGetFileInfo 兜底。
///
/// size 会被 clamp 到 [16, 128]。
pub(super) fn shortcut_icon_data_url(path: &str, size: u32) -> Result<Option<String>, String> {
    if path.trim().is_empty() {
        return Ok(None);
    }
    let size = size.clamp(16, 128);

    let cache_key = normalize_icon_cache_key(path, size);
    // 先查内存缓存，命中最快。
    if let Some(cached_icon) = lock_mutex(icon_cache()).get(&cache_key) {
        return Ok(Some(cached_icon));
    }
    // 再查磁盘缓存，减少冷启动重复提取成本。
    if let Some(disk_cached_icon) = read_icon_from_disk_cache(&cache_key) {
        lock_mutex(icon_cache()).insert(cache_key.clone(), disk_cached_icon.clone());
        return Ok(Some(disk_cached_icon));
    }

    // .lnk 快捷方式：SHGetFileInfo 快速路径优先
    let icon = if is_shortcut_file(path) {
        match shortcut_icon_data_url_fallback(path, size) {
            Ok(Some(icon)) => Ok(Some(icon)),
            Ok(None) => {
                if size <= 64 {
                    Ok(None)
                } else {
                    // 大尺寸时回退到 IShellItemImageFactory（慢但质量高）
                    unsafe { shortcut_icon_data_url_shell_item(path, size) }
                }
            }
            Err(err) => {
                warn!(
                    "[QuickSearch] Fast shortcut icon extraction failed for '{}': {}",
                    path, err
                );
                if size <= 64 {
                    Ok(None)
                } else {
                    unsafe { shortcut_icon_data_url_shell_item(path, size) }
                }
            }
        }
    } else {
        // 普通文件：按扩展名查系统图标，失败再用 SHGetFileInfo 兜底
        match shortcut_icon_data_url_by_extension(path, size) {
            Ok(Some(icon)) => Ok(Some(icon)),
            Ok(None) => shortcut_icon_data_url_fallback(path, size),
            Err(err) => {
                warn!(
                    "[QuickSearch] File-type icon extraction failed for '{}': {}. Falling back.",
                    path, err
                );
                shortcut_icon_data_url_fallback(path, size)
            }
        }
    }?;

    // 提取成功后写回双层缓存
    if let Some(data_url) = icon.as_ref() {
        lock_mutex(icon_cache()).insert(cache_key.clone(), data_url.clone());
        write_icon_to_disk_cache(&cache_key, data_url);
    }

    Ok(icon)
}

/// 获取单个图片的缩略图 Data URL。
///
/// 通过 IShellItemImageFactory 提取 Windows Shell 缓存中的缩略图，
/// 并经由内存 / 磁盘双层缓存加速后续请求。size 会被 clamp 到 [24, 128]。
pub(super) fn image_thumbnail_data_url(path: &str, size: u32) -> Result<Option<String>, String> {
    if path.trim().is_empty() {
        return Ok(None);
    }

    let size = size.clamp(24, 128);
    let cache_key = normalize_thumbnail_cache_key(path, size);
    if let Some(cached_thumbnail) = lock_mutex(icon_cache()).get(&cache_key) {
        return Ok(Some(cached_thumbnail));
    }
    if let Some(disk_cached_thumbnail) = read_icon_from_disk_cache(&cache_key) {
        lock_mutex(icon_cache()).insert(cache_key.clone(), disk_cached_thumbnail.clone());
        return Ok(Some(disk_cached_thumbnail));
    }

    let thumbnail = match unsafe { image_thumbnail_data_url_shell_item(path, size) } {
        Ok(Some(data_url)) => Some(data_url),
        Ok(None) => None,
        Err(error) => {
            warn!(
                "[QuickSearch] Image thumbnail extraction failed for '{}': {}",
                path, error
            );
            None
        }
    };

    if let Some(data_url) = thumbnail.as_ref() {
        lock_mutex(icon_cache()).insert(cache_key.clone(), data_url.clone());
        write_icon_to_disk_cache(&cache_key, data_url);
    }

    Ok(thumbnail)
}

/// 批量获取快捷方式图标。
///
/// 返回 { 原始路径 → Data URL } 映射，按路径（大小写不敏感）去重。
pub(super) fn get_shortcut_icons(
    paths: Vec<String>,
    size: u32,
) -> Result<HashMap<String, String>, String> {
    let normalized_size = size.clamp(16, 256);
    let mut seen_paths = HashSet::new();
    let mut result = HashMap::new();

    for path in paths {
        if path.trim().is_empty() {
            continue;
        }
        let dedupe_key = path.to_lowercase();
        if !seen_paths.insert(dedupe_key) {
            continue;
        }
        if let Some(icon_data) = shortcut_icon_data_url(&path, normalized_size)? {
            result.insert(path, icon_data);
        }
    }
    Ok(result)
}

/// 批量获取图片缩略图。
///
/// 每个路径须通过白名单校验（由 [remember_search_paths] 注册），
/// 且单次请求路径数不得超过 [MAX_IMAGE_THUMBNAIL_PATHS_PER_REQUEST]。
/// 返回 { 原始路径 → Data URL } 映射。
pub(super) fn get_image_thumbnails(
    paths: Vec<String>,
    size: u32,
) -> Result<HashMap<String, String>, String> {
    if paths.len() > MAX_IMAGE_THUMBNAIL_PATHS_PER_REQUEST {
        return Err(format!(
            "Too many paths requested for thumbnails (max {})",
            MAX_IMAGE_THUMBNAIL_PATHS_PER_REQUEST
        ));
    }

    let normalized_size = size.clamp(16, 256);
    let mut seen_paths = HashSet::new();
    let mut result = HashMap::new();

    for path in paths {
        if path.trim().is_empty() {
            continue;
        }

        let Some(validated_path) = validate_thumbnail_request_path(&path) else {
            continue;
        };

        let dedupe_key = normalize_path(&validated_path);
        if !seen_paths.insert(dedupe_key) {
            continue;
        }

        if let Some(thumbnail_data) = image_thumbnail_data_url(&validated_path, normalized_size)? {
            result.insert(path, thumbnail_data);
        }
    }

    Ok(result)
}

/// 内存 LRU + 磁盘 JPEG 缓存。
mod cache;
/// RGBA / BGRA 色彩转换与 Data URL 编码。
mod codec;
/// Windows Shell API 图标 / 缩略图提取。
mod win;
