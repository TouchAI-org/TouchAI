// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 快速搜索调度层。
//!
//! 这一层负责三件事：
//! 1. 维护快捷方式本地索引与状态快照；
//! 2. 组合“本地索引 + Everything 前台查询”的两阶段搜索；
//! 3. 在后台异步补全 `.lnk` 目标信息，避免把主查询链路拖慢。

use super::types::{QuickSearchFileItem, QuickSearchStatus, QuickShortcutItem};
use log::{debug, warn};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock, RwLock,
    },
    thread,
    time::{Duration, Instant},
};

use super::provider_everything::EverythingClient;

// 子模块拆分：
// - `matching`：路径归一化、分词、打分与去重键构建
// - `shortcut_target`：`.lnk` 目标解析（COM/Shell）
// - `state`：调度层共享状态与数据结构
// - `sync`：中毒锁的统一处理
mod matching;
mod shortcut_target;
mod state;
mod sync;

use matching::{
    build_result_dedupe_key, classify_shortcut_source, collect_search_roots,
    display_name_from_path, extract_shortcut_name, is_lnk_file, normalize_for_match,
    normalize_path_str, read_file_fingerprint, score_shortcut_record, tokenize_query,
};
use shortcut_target::resolve_shortcut_target_metadata;
use state::{
    AtomicFlagGuard, PendingTargetResolve, QuickSearchProvider, QuickSearchState,
    ResolvedTargetUpdate, SearchRoot, ShortcutRecord, TargetCacheEntry,
};
use sync::{lock_mutex, read_lock, try_lock_mutex, write_lock};

const INDEX_REFRESH_TTL: Duration = Duration::from_secs(30);
const TARGET_RESOLVER_WORKERS: usize = 2;
const EVERYTHING_QUERY_MIN_RESULTS: usize = 24;
const EVERYTHING_QUERY_MAX_RESULTS: usize = 120;
const EVERYTHING_QUERY_LIMIT_MULTIPLIER: usize = 2;
const EVERYTHING_QUERY_EXTRA_RESULTS: usize = 12;

/// 快速搜索调度器。
struct QuickSearchManager {
    /// 索引状态与记录（读多写少）。
    state: RwLock<QuickSearchState>,
    /// Everything IPC 客户端（串行访问）。
    everything_client: Mutex<EverythingClient>,
    /// 刷新任务互斥标记。
    refresh_inflight: AtomicBool,
    /// 目标解析任务互斥标记。
    resolve_inflight: AtomicBool,
    /// 快捷方式来源根目录缓存。
    roots: Vec<SearchRoot>,
    /// 快捷方式目标解析缓存（按 path_norm）。
    target_cache: RwLock<HashMap<String, TargetCacheEntry>>,
}

impl QuickSearchManager {
    /// 创建调度器并预收集来源根目录。
    fn new() -> Self {
        let roots = collect_search_roots();

        Self {
            state: RwLock::new(QuickSearchState::default()),
            everything_client: Mutex::new(EverythingClient::new()),
            refresh_inflight: AtomicBool::new(false),
            resolve_inflight: AtomicBool::new(false),
            roots,
            target_cache: RwLock::new(HashMap::new()),
        }
    }

    /// 返回当前运行状态快照。
    fn status(&self) -> QuickSearchStatus {
        let state = read_lock(&self.state);
        QuickSearchStatus {
            provider: state.provider.as_str().to_string(),
            db_loaded: state.db_loaded,
            index_warmed: state.index_warmed,
            last_refresh_ms: state.last_refresh_ms,
            last_error: state.last_error.clone(),
        }
    }

    /// 执行两阶段搜索。
    ///
    /// 第一阶段优先走本地快捷方式索引，保证大部分查询能以低延迟返回；
    /// 如果索引结果不足，再前台补查 Everything 普通文件，把剩余名额补齐。
    /// 这样既保留了快捷方式排序质量，也避免所有查询都落到较重的 IPC 调用上。
    fn search(self: &'static Self, query: &str, limit: usize) -> Vec<QuickShortcutItem> {
        let trimmed_query = query.trim();
        if trimmed_query.is_empty() {
            return Vec::new();
        }

        let query_tokens = tokenize_query(trimmed_query);
        if query_tokens.is_empty() {
            return Vec::new();
        }

        let started = Instant::now();
        let state = read_lock(&self.state);
        let shortcut_records = &state.records;

        // 第一阶段：用本地索引做模糊匹配排序。
        let mut shortcut_entries: Vec<(QuickShortcutItem, i32, String, String, String)> =
            shortcut_records
                .iter()
                .filter_map(|record| {
                    let score = score_shortcut_record(record, &query_tokens)?;
                    let dedupe_key = build_result_dedupe_key(record);
                    Some((
                        record.item.clone(),
                        score,
                        dedupe_key,
                        record.path_norm.clone(),
                        record.name_norm.clone(),
                    ))
                })
                .collect();
        drop(state);

        shortcut_entries.sort_by(|left, right| {
            right
                .1
                .cmp(&left.1)
                .then_with(|| left.4.cmp(&right.4))
                .then_with(|| left.3.cmp(&right.3))
        });

        // 两套去重同时存在：
        // - 快捷方式去重键：去掉指向同一目标的重复快捷方式别名；
        // - 路径：避免第二阶段文件结果把第一阶段已有路径重新塞回来。
        let mut seen_paths = HashSet::new();
        let mut seen_shortcut_keys = HashSet::new();
        let mut results = Vec::with_capacity(limit);

        for (item, _, dedupe_key, path_norm, _) in shortcut_entries {
            if !seen_shortcut_keys.insert(dedupe_key) {
                continue;
            }
            if !seen_paths.insert(path_norm) {
                continue;
            }
            results.push(item);
            if results.len() >= limit {
                break;
            }
        }

        let remaining_slots = limit.saturating_sub(results.len());
        if remaining_slots == 0 {
            debug!(
                "[QuickSearch] fuzzy_match_ms={} result_count={} stage=shortcut_only",
                started.elapsed().as_millis(),
                results.len()
            );
            return results;
        }

        let query_limit = (remaining_slots
            .saturating_mul(EVERYTHING_QUERY_LIMIT_MULTIPLIER)
            .saturating_add(EVERYTHING_QUERY_EXTRA_RESULTS))
        .clamp(EVERYTHING_QUERY_MIN_RESULTS, EVERYTHING_QUERY_MAX_RESULTS);

        // 第二阶段：尝试前台向 Everything 查询补足普通文件结果。
        let everything_paths = match try_lock_mutex(&self.everything_client) {
            Some(mut client) => match client.query_paths(trimmed_query, query_limit as u32) {
                Ok(paths) => Some(paths),
                Err(error) => {
                    debug!(
                        "[QuickSearch] foreground query failed, fallback to cached results only: {}",
                        error.message
                    );
                    None
                }
            },
            None => {
                debug!(
                    "[QuickSearch] everything client busy, skip foreground file query this round"
                );
                None
            }
        };

        let mut file_entries: Vec<(QuickShortcutItem, bool, String, String)> = Vec::new();
        if let Some(paths) = everything_paths {
            for path in paths {
                let path_norm = normalize_path_str(&path);
                if seen_paths.contains(&path_norm) {
                    continue;
                }

                let path_obj = Path::new(&path);
                let is_shortcut = is_lnk_file(path_obj);
                let Some(name) = display_name_from_path(path_obj, is_shortcut) else {
                    continue;
                };
                let name_norm = normalize_for_match(&name);
                let source = if is_shortcut {
                    classify_shortcut_source(&path_norm, &self.roots).to_string()
                } else {
                    "file".to_string()
                };

                file_entries.push((
                    QuickShortcutItem { name, path, source },
                    is_shortcut,
                    path_norm,
                    name_norm,
                ));
            }
        }

        file_entries.sort_by(|left, right| {
            right
                .1
                .cmp(&left.1)
                .then_with(|| left.3.cmp(&right.3))
                .then_with(|| left.2.cmp(&right.2))
        });

        for (item, _, path_norm, _) in file_entries {
            if !seen_paths.insert(path_norm) {
                continue;
            }
            results.push(item);
            if results.len() >= limit {
                break;
            }
        }

        debug!(
            "[QuickSearch] fuzzy_match_ms={} result_count={} query_limit={}",
            started.elapsed().as_millis(),
            results.len(),
            query_limit
        );

        // 异步触发后台刷新，不阻塞当前搜索返回。
        let _ = self.refresh_index(false, true);
        results
    }

    /// 直接查询 Everything 普通文件结果。
    fn search_files(
        self: &'static Self,
        query: &str,
        limit: usize,
        include_shortcuts: bool,
    ) -> Result<Vec<QuickSearchFileItem>, String> {
        let trimmed_query = query.trim();
        if trimmed_query.is_empty() {
            return Ok(Vec::new());
        }

        let paths = {
            let mut client = lock_mutex(&self.everything_client);
            let db_loaded = client
                .is_db_loaded()
                .map_err(|error| self.map_everything_error(error))?;

            if !db_loaded {
                self.update_database_loading_state();
                return Err("Everything 数据库尚未加载完成".to_string());
            }

            client
                .query_file_paths(trimmed_query, limit as u32, include_shortcuts)
                .map_err(|error| self.map_everything_error(error))?
        };

        self.mark_everything_ready();

        let mut seen_paths = HashSet::new();
        let mut results = Vec::with_capacity(paths.len());

        for path in paths {
            let path_norm = normalize_path_str(&path);
            if !seen_paths.insert(path_norm) {
                continue;
            }

            let path_obj = Path::new(&path);
            let is_shortcut = is_lnk_file(path_obj);
            let Some(name) = display_name_from_path(path_obj, is_shortcut) else {
                continue;
            };

            results.push(QuickSearchFileItem { name, path });
            if results.len() >= limit {
                break;
            }
        }

        Ok(results)
    }

    /// 触发一次索引刷新。
    ///
    /// `background=true` 时只负责把任务投到后台线程，前台请求继续返回当前结果；
    /// `background=false` 时用于显式预热，调用方会等待刷新完成。
    fn refresh_index(self: &'static Self, force: bool, background: bool) -> Result<(), String> {
        if !self.should_refresh(force) {
            return Ok(());
        }

        if self
            .refresh_inflight
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            // 已有刷新任务在跑，直接复用其结果。
            return Ok(());
        }

        if background {
            thread::spawn(move || self.refresh_worker());
            return Ok(());
        }

        self.refresh_worker();
        Ok(())
    }

    /// 根据过期时间与预热状态判断是否需要刷新。
    fn should_refresh(&self, force: bool) -> bool {
        if force {
            return true;
        }

        let state = read_lock(&self.state);
        if !state.index_warmed {
            return true;
        }

        match state.next_refresh_after {
            Some(next_refresh_after) => Instant::now() >= next_refresh_after,
            None => true,
        }
    }

    /// 执行一次完整刷新：检查数据库、拉取 `.lnk`、重建索引、触发目标补全。
    ///
    /// 刷新流程刻意拆成“先快速建索引，再后台补目标信息”两步：
    /// 这样搜索主流程尽快有可用结果，而 `.lnk` 目标解析这类更慢的操作
    /// 可以在索引建立后异步回写，不阻塞搜索首屏体验。
    fn refresh_worker(self: &'static Self) {
        let _guard = AtomicFlagGuard::new(&self.refresh_inflight);
        let refresh_started = Instant::now();

        let db_loaded_result = {
            let mut client = lock_mutex(&self.everything_client);
            client.is_db_loaded()
        };

        let db_loaded = match db_loaded_result {
            Ok(value) => value,
            Err(error) => {
                self.update_provider_error(&error.message, error.is_ipc_unavailable());
                return;
            }
        };

        if !db_loaded {
            let mut state = write_lock(&self.state);
            state.provider = QuickSearchProvider::Everything;
            state.db_loaded = false;
            state.last_error = Some("Everything 数据库尚未加载完成".to_string());
            state.next_refresh_after = Some(Instant::now() + INDEX_REFRESH_TTL);
            return;
        }

        let query_started = Instant::now();
        let query_paths = {
            let mut client = lock_mutex(&self.everything_client);
            client.query_lnk_paths()
        };

        let paths = match query_paths {
            Ok(paths) => paths,
            Err(error) => {
                self.update_provider_error(&error.message, error.is_ipc_unavailable());
                return;
            }
        };
        let query_ms = query_started.elapsed().as_millis() as u64;

        let cache = read_lock(&self.target_cache);
        let mut seen_paths = HashSet::new();
        let mut records = Vec::new();
        let mut pending_targets = Vec::new();
        let mut cache_hits = 0_u64;
        let mut cache_checks = 0_u64;

        for path in paths {
            let shortcut_path = PathBuf::from(&path);
            if !is_lnk_file(&shortcut_path) {
                continue;
            }

            let path_norm = normalize_path_str(&path);
            if !seen_paths.insert(path_norm.clone()) {
                continue;
            }

            let source = classify_shortcut_source(&path_norm, &self.roots);

            let Some(name) = extract_shortcut_name(&shortcut_path) else {
                continue;
            };

            // 指纹只保留“最后修改时间 + 文件大小”这类廉价信息，
            // 目的是快速判断缓存里的目标解析结果是否还能复用。
            let (modified_secs, file_size) = read_file_fingerprint(&shortcut_path);
            let mut target_name: Option<String> = None;
            let mut target_path: Option<String> = None;

            cache_checks += 1;
            // 命中同指纹缓存时直接复用目标信息，避免重复解析 .lnk。
            if let Some(cache_entry) = cache.get(&path_norm) {
                if cache_entry.modified_secs == modified_secs && cache_entry.file_size == file_size
                {
                    target_name = cache_entry.target_name.clone();
                    target_path = cache_entry.target_path.clone();
                    cache_hits += 1;
                }
            }

            if target_name.is_none() && target_path.is_none() {
                // 未命中缓存的项交给后台解析器并发补全。
                pending_targets.push(PendingTargetResolve {
                    path: path.clone(),
                    path_norm: path_norm.clone(),
                    modified_secs,
                    file_size,
                });
            }

            let target_norm = target_name
                .as_deref()
                .map(normalize_for_match)
                .unwrap_or_default();

            records.push(ShortcutRecord {
                item: QuickShortcutItem {
                    name: name.clone(),
                    path: path.clone(),
                    source: source.to_string(),
                },
                path_norm,
                name_norm: normalize_for_match(&name),
                target_name,
                target_path,
                target_norm,
                modified_secs,
                file_size,
            });
        }
        drop(cache);

        records.sort_by(|left, right| {
            left.name_norm
                .cmp(&right.name_norm)
                .then_with(|| left.path_norm.cmp(&right.path_norm))
        });

        let refresh_ms = refresh_started.elapsed().as_millis() as u64;
        {
            let mut state = write_lock(&self.state);
            state.provider = QuickSearchProvider::Everything;
            state.db_loaded = true;
            state.index_warmed = true;
            state.last_error = None;
            state.last_refresh_ms = Some(refresh_ms);
            state.records = records;
            state.next_refresh_after = Some(Instant::now() + INDEX_REFRESH_TTL);
        }

        let cache_hit_rate = if cache_checks == 0 {
            0.0
        } else {
            (cache_hits as f64 / cache_checks as f64) * 100.0
        };
        debug!(
            "[QuickSearch] everything_query_ms={} index_refresh_ms={} result_count={} cache_hit_rate(target_name)={:.1}%",
            query_ms,
            refresh_ms,
            read_lock(&self.state).records.len(),
            cache_hit_rate
        );

        self.spawn_target_resolver(pending_targets);
    }

    /// 更新提供者错误状态并设置下一次可刷新时间。
    fn update_provider_error(&self, error_message: &str, ipc_unavailable: bool) {
        let mut state = write_lock(&self.state);
        state.provider = if ipc_unavailable {
            QuickSearchProvider::Unavailable
        } else {
            QuickSearchProvider::Everything
        };
        state.db_loaded = false;
        state.last_error = Some(error_message.to_string());
        state.next_refresh_after = Some(Instant::now() + INDEX_REFRESH_TTL);
    }

    /// 文件搜索成功后同步提供者状态。
    ///
    /// `file_search` 可能先于常规快捷搜索发生；如果这里不更新状态，
    /// 前端会看到“查询成功了，但状态还停留在未就绪”的假象。
    fn mark_everything_ready(&self) {
        let mut state = write_lock(&self.state);
        state.provider = QuickSearchProvider::Everything;
        state.db_loaded = true;
        state.last_error = None;
    }

    /// 把状态切到“Everything 正在加载数据库”。
    fn update_database_loading_state(&self) {
        let mut state = write_lock(&self.state);
        state.provider = QuickSearchProvider::Everything;
        state.db_loaded = false;
        state.last_error = Some("Everything 数据库尚未加载完成".to_string());
        state.next_refresh_after = Some(Instant::now() + INDEX_REFRESH_TTL);
    }

    /// 把 Everything 底层错误同步到状态机，再返回给上层调用者。
    fn map_everything_error(&self, error: super::provider_everything::EverythingError) -> String {
        self.update_provider_error(&error.message, error.is_ipc_unavailable());
        error.message
    }

    /// 在后台异步启动目标解析批处理（同一时刻最多一批）。
    fn spawn_target_resolver(self: &'static Self, pending_targets: Vec<PendingTargetResolve>) {
        if pending_targets.is_empty() {
            return;
        }

        if self
            .resolve_inflight
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            // 同一时刻仅允许一个解析批次，防止重复竞争。
            return;
        }

        thread::spawn(move || self.resolve_targets_worker(pending_targets));
    }

    /// 并发解析快捷方式目标，并回写索引与缓存。
    ///
    /// 这里单独起工作线程批次而不是在刷新线程里串行解析，
    /// 是为了把较慢的 COM / Shell 目标解析从索引重建路径中剥离出去。
    fn resolve_targets_worker(self: &'static Self, pending_targets: Vec<PendingTargetResolve>) {
        let _guard = AtomicFlagGuard::new(&self.resolve_inflight);
        // 任务队列 + 更新缓冲，供多个工作线程共享。
        let queue = Arc::new(Mutex::new(VecDeque::from(pending_targets)));
        let updates = Arc::new(Mutex::new(Vec::<ResolvedTargetUpdate>::new()));

        let worker_count = TARGET_RESOLVER_WORKERS.max(1);
        let mut handles = Vec::with_capacity(worker_count);

        for _ in 0..worker_count {
            let queue_ref = Arc::clone(&queue);
            let updates_ref = Arc::clone(&updates);

            handles.push(thread::spawn(move || loop {
                let task = {
                    let mut queue_guard = lock_mutex(&queue_ref);
                    queue_guard.pop_front()
                };
                let Some(task) = task else {
                    break;
                };

                // 目标解析依赖 Windows Shell/COM，单个任务可能比较慢，
                // 因此工作线程只负责产生更新结果，不直接持有全局状态锁。
                let metadata = unsafe { resolve_shortcut_target_metadata(Path::new(&task.path)) };
                let Some(metadata) = metadata else {
                    continue;
                };
                if metadata.target_name.is_none() && metadata.target_path.is_none() {
                    continue;
                }

                let mut updates_guard = lock_mutex(&updates_ref);
                updates_guard.push(ResolvedTargetUpdate {
                    path_norm: task.path_norm.clone(),
                    modified_secs: task.modified_secs,
                    file_size: task.file_size,
                    target_name: metadata.target_name,
                    target_path: metadata.target_path,
                });
            }));
        }
        for handle in handles {
            if let Err(error) = handle.join() {
                warn!(
                    "[QuickSearch] target resolver worker join failed: {:?}",
                    error
                );
            }
        }

        let updates = {
            let updates_guard = lock_mutex(&updates);
            updates_guard.clone()
        };
        if updates.is_empty() {
            return;
        }

        {
            let mut state = write_lock(&self.state);
            let mut cache = write_lock(&self.target_cache);

            // 同步更新内存索引和缓存映射，保证查询即时可见。
            for update in &updates {
                if let Some(record) = state.records.iter_mut().find(|record| {
                    record.path_norm == update.path_norm
                        && record.modified_secs == update.modified_secs
                        && record.file_size == update.file_size
                }) {
                    record.target_name = update.target_name.clone();
                    record.target_path = update.target_path.clone();
                    record.target_norm = update
                        .target_name
                        .as_deref()
                        .map(normalize_for_match)
                        .unwrap_or_default();
                }

                cache.insert(
                    update.path_norm.clone(),
                    TargetCacheEntry {
                        modified_secs: update.modified_secs,
                        file_size: update.file_size,
                        target_name: update.target_name.clone(),
                        target_path: update.target_path.clone(),
                    },
                );
            }
        }
    }
}

/// 触发索引预热/刷新。
pub fn prepare_index(force: bool) -> Result<(), String> {
    manager().refresh_index(force, true)
}

/// 获取快速搜索当前状态。
pub fn get_status() -> QuickSearchStatus {
    manager().status()
}

/// 执行搜索并返回排序后的快捷项结果。
pub fn search_shortcuts(query: &str, limit: usize) -> Vec<QuickShortcutItem> {
    manager().search(query, limit.max(1))
}

/// 执行文件搜索并返回 Everything 结果。
pub fn search_files(
    query: &str,
    limit: usize,
    include_shortcuts: bool,
) -> Result<Vec<QuickSearchFileItem>, String> {
    manager().search_files(query, limit.max(1), include_shortcuts)
}

/// 返回全局单例调度器。
///
/// 搜索状态、缓存和后台任务都依赖共享实例；如果每次调用都重新构造，
/// 过期时间、目标缓存和进行中互斥都会失效。
fn manager() -> &'static QuickSearchManager {
    static MANAGER: OnceLock<QuickSearchManager> = OnceLock::new();
    MANAGER.get_or_init(QuickSearchManager::new)
}
