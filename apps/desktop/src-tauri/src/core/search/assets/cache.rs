// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 图标 / 缩略图双层缓存。
//!
//! 提供内存 LRU 缓存和磁盘图像缓存两级加速：
//!
//! 1. 内存 LRU（[IconCache]）：容量 [ICON_CACHE_CAPACITY] 条，
//!    以 cache_key → data_url 形式存储，访问时自动提升到队尾。
//! 2. 磁盘缓存：图标保留 PNG 透明通道，缩略图使用 JPEG。
//!    写入 {app_root}/cache/icons/{hash}.{png,jpeg}，冷启动时可直接读取。
//!
//! # 缓存键策略
//!
//! - 图标：按 type|path|size 格式（[normalize_icon_cache_key]），
//!   同扩展名的非快捷方式文件共享同一图标缓存。
//! - 缩略图：按 thumb|path|mtime|fsize|size 格式（[normalize_thumbnail_cache_key]），
//!   文件内容变化后自动失效。

use super::codec::rgba_to_rgb_over_white;
use crate::core::system::paths::{app_directory_path, AppDirectory};
use base64::Engine as _;
use image::{codecs::jpeg::JpegEncoder, ColorType, ImageFormat};
use log::warn;
use std::{
    collections::hash_map::DefaultHasher,
    collections::{HashMap, VecDeque},
    fs,
    hash::{Hash, Hasher},
    io::Cursor,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard, OnceLock},
    time::UNIX_EPOCH,
};

/// 内存 LRU 缓存最大条目数。
const ICON_CACHE_CAPACITY: usize = 512;
/// 缓存键二次哈希盐值，用于降低碰撞概率。
const ICON_CACHE_HASH_SALT: &str = "icon_cache_v1";
/// 缓存键前缀：快捷方式图标。
const CACHE_KEY_PREFIX_SHORTCUT: &str = "shortcut";
/// 缓存键前缀：图片文件图标。
const CACHE_KEY_PREFIX_IMAGE: &str = "image";
/// 缓存键前缀：按扩展名共享图标。
const CACHE_KEY_PREFIX_EXT: &str = "ext";
/// 缓存键前缀：缩略图。
const CACHE_KEY_PREFIX_THUMB: &str = "thumb";
/// 无扩展名占位符。
const CACHE_KEY_EXT_NONE_TOKEN: &str = "<none>";
/// 快捷方式扩展名。
const SHORTCUT_EXTENSION: &str = "lnk";
/// Data URL 图片前缀。
const DATA_URL_IMAGE_PREFIX: &str = "data:image/";
/// Data URL Base64 标记。
const DATA_URL_BASE64_MARKER: &str = ";base64";
/// JPEG 质量下限。
const JPEG_QUALITY_MIN: u8 = 20;
/// JPEG 质量上限。
const JPEG_QUALITY_MAX: u8 = 95;
/// 磁盘缓存 JPEG 编码质量（0–100），偏低以减小体积。
const THUMBNAIL_JPEG_QUALITY: u8 = 46;

// ---------------------------------------------------------------------------
// 内存 LRU 缓存
// ---------------------------------------------------------------------------

/// 简易 LRU 缓存：HashMap 存值，VecDeque 维护访问顺序。
///
/// 超过 [ICON_CACHE_CAPACITY] 时淘汰最久未访问的条目。
#[derive(Default)]
pub(super) struct IconCache {
    /// cache_key → Data URL。
    values: HashMap<String, String>,
    /// 按访问时间排列的 key 队列，队尾为最近访问。
    order: VecDeque<String>,
}

impl IconCache {
    /// 查询缓存，命中时将 key 提升至队尾。
    pub(super) fn get(&mut self, key: &str) -> Option<String> {
        let value = self.values.get(key)?.clone();
        self.touch(key);
        Some(value)
    }

    /// 插入或更新条目，超量时淘汰队首（最旧）条目。
    pub(super) fn insert(&mut self, key: String, value: String) {
        self.values.insert(key.clone(), value);
        self.touch(&key);

        // 淘汰最久未访问的条目
        while self.values.len() > ICON_CACHE_CAPACITY {
            let Some(oldest_key) = self.order.pop_front() else {
                break;
            };
            self.values.remove(&oldest_key);
        }
    }

    /// 将 key 移动到队尾，标记为最近访问。
    fn touch(&mut self, key: &str) {
        if let Some(position) = self.order.iter().position(|current| current == key) {
            self.order.remove(position);
        }
        self.order.push_back(key.to_string());
    }
}

/// 获取全局 [IconCache] 单例。
pub(super) fn icon_cache() -> &'static Mutex<IconCache> {
    static CACHE: OnceLock<Mutex<IconCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(IconCache::default()))
}

/// 安全获取 Mutex 锁，中毒时自动恢复。
pub(super) fn lock_mutex<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// 返回缩略图 JPEG 编码质量参数，供 [super::win] 调用。
pub(super) fn thumbnail_jpeg_quality() -> u8 {
    THUMBNAIL_JPEG_QUALITY
}

// ---------------------------------------------------------------------------
// 缓存键生成
// ---------------------------------------------------------------------------

/// 生成图标缓存键。
///
/// 键格式根据文件类型不同：
/// - .lnk 快捷方式：shortcut|{path}|{size} — 每个快捷方式有独立图标
/// - 图片文件：image|{path}|{size} — 每个图片有独立图标
/// - 其他文件：ext|{ext}|{size} — 同扩展名共享系统图标
pub(super) fn normalize_icon_cache_key(path: &str, size: u32) -> String {
    let normalized_path = path.replace('/', "\\").to_lowercase();
    let extension = Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.trim().to_lowercase());
    let is_shortcut = extension
        .as_deref()
        .is_some_and(|ext| ext.eq_ignore_ascii_case(SHORTCUT_EXTENSION));

    if is_shortcut {
        return format!("{}|{}|{}", CACHE_KEY_PREFIX_SHORTCUT, normalized_path, size);
    }

    if extension
        .as_deref()
        .is_some_and(|ext| is_image_extension(ext))
    {
        return format!("{}|{}|{}", CACHE_KEY_PREFIX_IMAGE, normalized_path, size);
    }

    match extension {
        Some(ext) if !ext.is_empty() => format!("{}|{}|{}", CACHE_KEY_PREFIX_EXT, ext, size),
        _ => format!(
            "{}|{}|{}",
            CACHE_KEY_PREFIX_EXT, CACHE_KEY_EXT_NONE_TOKEN, size
        ),
    }
}

/// 生成缩略图缓存键：thumb|{path}|{mtime}|{fsize}|{size}。
///
/// 包含文件修改时间和大小作为指纹，文件内容变化后缓存自动失效。
pub(super) fn normalize_thumbnail_cache_key(path: &str, size: u32) -> String {
    let normalized_path = path.replace('/', "\\").to_lowercase();
    let (modified_nanos, file_size) = file_fingerprint(path);
    format!(
        "{}|{}|{}|{}|{}",
        CACHE_KEY_PREFIX_THUMB, normalized_path, modified_nanos, file_size, size
    )
}

// ---------------------------------------------------------------------------
// 磁盘缓存读写
// ---------------------------------------------------------------------------

/// Read the cached image using its original PNG or JPEG media type.
pub(super) fn read_icon_from_disk_cache(cache_key: &str) -> Option<String> {
    let cache_path = icon_disk_cache_file_path(cache_key)?;
    read_cached_image(&cache_path)
}

fn read_cached_image(cache_path: &Path) -> Option<String> {
    let bytes = fs::read(cache_path).ok()?;
    let format = ImageFormat::from_path(cache_path).ok()?;
    if image::guess_format(&bytes).ok()? != format {
        return None;
    }
    Some(format!(
        "data:{};base64,{}",
        format.to_mime_type(),
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

/// Persist icons losslessly; thumbnail compression remains separate.
pub(super) fn write_icon_to_disk_cache(cache_key: &str, data_url: &str) {
    let Some(cache_path) = icon_disk_cache_file_path(cache_key) else {
        return;
    };
    write_cached_image(&cache_path, data_url);
}

fn write_cached_image(cache_path: &Path, data_url: &str) {
    // 解码 Data URL 中的 base64 图像字节
    let Some(image_bytes) = decode_data_url_image_bytes(data_url) else {
        return;
    };
    let Ok(format) = ImageFormat::from_path(cache_path) else {
        return;
    };
    let encoded = if image::guess_format(&image_bytes).ok() == Some(format) {
        // Native extraction already returns the correct format; avoid recompression.
        Ok(image_bytes)
    } else if format == ImageFormat::Png {
        image::load_from_memory(&image_bytes)
            .and_then(|image| {
                let mut bytes = Cursor::new(Vec::new());
                image.write_to(&mut bytes, ImageFormat::Png)?;
                Ok(bytes.into_inner())
            })
            .map_err(|error| error.to_string())
    } else {
        reencode_image_bytes_to_jpeg(&image_bytes, THUMBNAIL_JPEG_QUALITY)
    };
    let image_bytes = match encoded {
        Ok(bytes) => bytes,
        Err(error) => {
            warn!("[QuickSearch] Failed to encode cached image: {}", error);
            return;
        }
    };
    if let Err(error) = fs::write(cache_path, image_bytes) {
        warn!(
            "[QuickSearch] Failed to write icon disk cache '{}': {}",
            cache_path.display(),
            error
        );
    }
}

// ---------------------------------------------------------------------------
// 内部辅助函数
// ---------------------------------------------------------------------------

/// 判断扩展名是否为常见图片格式。
fn is_image_extension(extension: &str) -> bool {
    matches!(
        extension,
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "svg" | "avif"
    )
}

/// Returns the file's Unix nanosecond modification time and byte length.
fn file_fingerprint(path: &str) -> (u128, u64) {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(_) => return (0, 0),
    };
    let modified_nanos = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    (modified_nanos, metadata.len())
}

/// 对缓存键做双重哈希，生成 32 字符十六进制文件名。
///
/// 使用两轮 DefaultHasher（第二轮混入固定盐值）降低碰撞概率。
fn hash_icon_cache_key(cache_key: &str) -> String {
    let mut first = DefaultHasher::new();
    cache_key.hash(&mut first);
    let first_hash = first.finish();

    let mut second = DefaultHasher::new();
    ICON_CACHE_HASH_SALT.hash(&mut second);
    cache_key.hash(&mut second);
    let second_hash = second.finish();

    format!("{:016x}{:016x}", first_hash, second_hash)
}

/// 根据缓存键计算磁盘缓存文件完整路径。
fn icon_disk_cache_file_path(cache_key: &str) -> Option<PathBuf> {
    let icon_dir = match app_directory_path(AppDirectory::CacheIcons) {
        Ok(path) => path,
        Err(error) => {
            warn!(
                "[QuickSearch] Failed to resolve cache icons directory: {}",
                error
            );
            return None;
        }
    };
    // Old flattened JPEG icons are cache misses; regenerate from the shell.
    let extension = if cache_key.starts_with("thumb|") {
        "jpeg"
    } else {
        "png"
    };
    let file_name = format!("{}.{}", hash_icon_cache_key(cache_key), extension);
    Some(icon_dir.join(file_name))
}

/// 从 data:image/...;base64,... 格式的 Data URL 中解码出原始图像字节。
fn decode_data_url_image_bytes(data_url: &str) -> Option<Vec<u8>> {
    if !data_url.starts_with(DATA_URL_IMAGE_PREFIX) {
        return None;
    }
    let comma = data_url.find(',')?;
    let header = &data_url[..comma];
    if !header.contains(DATA_URL_BASE64_MARKER) {
        return None;
    }
    base64::engine::general_purpose::STANDARD
        .decode(&data_url[comma + 1..])
        .ok()
}

/// 将任意格式的图像字节重新编码为 JPEG。
///
/// 先解码为 RGBA，Alpha 通道合成到白色背景后编码为 RGB JPEG。
fn reencode_image_bytes_to_jpeg(bytes: &[u8], quality: u8) -> Result<Vec<u8>, String> {
    let image = image::load_from_memory(bytes)
        .map_err(|err| format!("Failed to decode cached image: {}", err))?;
    let rgba = image.to_rgba8();
    let width = rgba.width();
    let height = rgba.height();
    if width == 0 || height == 0 {
        return Err("Invalid image dimensions".to_string());
    }

    // Alpha 合成到白色背景，JPEG 不支持透明通道
    let rgb_bytes = rgba_to_rgb_over_white(rgba.as_raw());

    let mut jpeg_bytes = Vec::new();
    let mut encoder = JpegEncoder::new_with_quality(
        &mut jpeg_bytes,
        quality.clamp(JPEG_QUALITY_MIN, JPEG_QUALITY_MAX),
    );
    encoder
        .encode(&rgb_bytes, width, height, ColorType::Rgb8.into())
        .map_err(|err| format!("Failed to encode cache image to JPEG: {}", err))?;
    Ok(jpeg_bytes)
}

#[cfg(test)]
mod tests {
    use super::{
        decode_data_url_image_bytes, normalize_thumbnail_cache_key, read_cached_image,
        write_cached_image, IconCache,
    };
    use crate::core::search::assets::codec::encode_rgba_to_png_data_url;
    use std::{
        fs::{self, OpenOptions},
        time::{Duration, UNIX_EPOCH},
    };

    #[test]
    fn user_sees_transparent_icon_edges_and_original_colors_after_disk_cache_reload() {
        let temp = tempfile::tempdir().expect("temporary cache directory");
        let path = temp.path().join("icon.png");
        let pixels = vec![0, 0, 0, 0, 40, 80, 120, 128, 255, 255, 255, 255];
        let original = encode_rgba_to_png_data_url(3, 1, pixels.clone()).expect("source icon");

        write_cached_image(&path, &original);
        let restored = read_cached_image(&path).expect("cached icon");
        let bytes = decode_data_url_image_bytes(&restored).expect("restored image bytes");
        let image = image::load_from_memory(&bytes).expect("readable cached image");

        assert_eq!(image.to_rgba8().into_raw(), pixels);
        assert!(restored.starts_with("data:image/png;base64,"));
    }

    #[test]
    fn user_still_gets_a_readable_jpeg_thumbnail_after_disk_cache_reload() {
        let temp = tempfile::tempdir().expect("temporary cache directory");
        let path = temp.path().join("thumbnail.jpeg");
        let original =
            encode_rgba_to_png_data_url(1, 1, vec![20, 40, 60, 255]).expect("source thumbnail");

        write_cached_image(&path, &original);
        let restored = read_cached_image(&path).expect("cached thumbnail");
        let bytes = decode_data_url_image_bytes(&restored).expect("restored image bytes");
        let image = image::load_from_memory(&bytes).expect("readable cached image");

        assert!(restored.starts_with("data:image/jpeg;base64,"));
        assert_eq!((image.width(), image.height()), (1, 1));
    }

    #[test]
    fn user_gets_fresh_thumbnail_when_same_size_image_changes_within_one_second() {
        let temp = tempfile::tempdir().expect("temporary directory");
        let image = temp.path().join("photo.png");
        fs::write(&image, b"old").expect("first image");
        let set_modified = |nanos| {
            OpenOptions::new()
                .write(true)
                .open(&image)
                .expect("image handle")
                .set_times(
                    fs::FileTimes::new()
                        .set_modified(UNIX_EPOCH + Duration::new(1_700_000_000, nanos)),
                )
                .expect("set modification time");
        };
        set_modified(100_000_000);
        let path = image.to_string_lossy();
        let first_key = normalize_thumbnail_cache_key(&path, 64);
        let mut cache = IconCache::default();
        cache.insert(first_key.clone(), "old thumbnail".to_string());

        fs::write(&image, b"new").expect("replacement image");
        set_modified(900_000_000);
        let second_key = normalize_thumbnail_cache_key(&path, 64);

        assert_ne!(first_key, second_key);
        assert_eq!(cache.get(&second_key), None);
        cache.insert(second_key.clone(), "new thumbnail".to_string());
        assert_eq!(cache.get(&second_key), Some("new thumbnail".to_string()));
        assert_eq!(second_key, normalize_thumbnail_cache_key(&path, 64));
    }
}
