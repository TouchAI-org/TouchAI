// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//manager 调度层共享状态定义。
//!
//存放索引记录、刷新状态与后台任务通信载体类型。

use crate::core::search::types::QuickShortcutItem;
use std::{
    collections::HashMap,
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};

use super::matching::normalize_for_match;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum QuickSearchProvider {
    Everything,
    Unavailable,
}

impl QuickSearchProvider {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Everything => "everything",
            Self::Unavailable => "unavailable",
        }
    }
}

#[derive(Debug, Clone)]
pub(super) struct ShortcutRecord {
    pub(super) item: QuickShortcutItem,
    pub(super) path_norm: String,
    pub(super) name_norm: String,
    pub(super) target_name: Option<String>,
    pub(super) target_path: Option<String>,
    pub(super) target_norm: String,
    pub(super) modified_secs: u64,
    pub(super) file_size: u64,
}

#[derive(Debug, Clone)]
pub(super) struct PendingTargetResolve {
    pub(super) path: String,
    pub(super) path_norm: String,
    pub(super) modified_secs: u64,
    pub(super) file_size: u64,
}

#[derive(Debug, Clone)]
pub(crate) struct ResolvedTargetUpdate {
    //归一化快捷方式路径。
    pub(crate) path_norm: String,
    //快捷方式最近修改时间戳（秒）。
    pub(crate) modified_secs: u64,
    //快捷方式文件大小（字节）。
    pub(crate) file_size: u64,
    //解析出的目标名称。
    pub(crate) target_name: Option<String>,
    //解析出的目标路径。
    pub(crate) target_path: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct TargetCacheEntry {
    //快捷方式最近修改时间戳（秒）。
    pub(crate) modified_secs: u64,
    //快捷方式文件大小（字节）。
    pub(crate) file_size: u64,
    //缓存的目标名称。
    pub(crate) target_name: Option<String>,
    //缓存的目标路径。
    pub(crate) target_path: Option<String>,
}

#[derive(Debug, Clone)]
pub(super) struct SearchRoot {
    pub(super) prefix_norm: String,
    pub(super) source: &'static str,
}

#[derive(Debug)]
pub(super) struct QuickSearchState {
    //当前 provider 状态。
    pub(super) provider: QuickSearchProvider,
    //Everything DB 是否已加载完成。
    pub(super) db_loaded: bool,
    //是否已完成至少一次索引预热。
    pub(super) index_warmed: bool,
    //最近一次刷新耗时（毫秒）。
    pub(super) last_refresh_ms: Option<u64>,
    //最近一次错误信息。
    pub(super) last_error: Option<String>,
    //当前内存索引记录。
    pub(super) records: Vec<ShortcutRecord>,
    //path_norm → records 下标映射；回写解析结果时避免线性扫描。
    pub(super) record_index: HashMap<String, usize>,
    //下次允许刷新的时间点（TTL 控制）。
    pub(super) next_refresh_after: Option<Instant>,
}

impl Default for QuickSearchState {
    fn default() -> Self {
        Self {
            provider: QuickSearchProvider::Unavailable,
            db_loaded: false,
            index_warmed: false,
            last_refresh_ms: None,
            last_error: None,
            records: Vec::new(),
            record_index: HashMap::new(),
            next_refresh_after: None,
        }
    }
}

impl QuickSearchState {
    /// 用新快照一次性替换记录，并重建 `path_norm → 下标` 映射。
    ///
    /// 重建路径直接把映射与记录一起替换，旧映射不会指向新数组的错误位置。
    pub(super) fn replace_records(&mut self, records: Vec<ShortcutRecord>) {
        self.record_index.clear();
        self.record_index.reserve(records.len());
        for (index, record) in records.iter().enumerate() {
            self.record_index
                .entry(record.path_norm.clone())
                .or_insert(index);
        }
        self.records = records;
    }

    /// 把解析结果应用到内存索引，返回实际命中的更新数。
    ///
    /// 只有 `path_norm` 与 `modified_secs` / `file_size` 都匹配时才写入，
    /// 让迟到的解析结果不会覆盖已变化的快捷方式。
    pub(super) fn apply_target_updates(&mut self, updates: &[ResolvedTargetUpdate]) -> usize {
        let mut applied = 0;

        for update in updates {
            let Some(&index) = self.record_index.get(&update.path_norm) else {
                continue;
            };
            let Some(record) = self.records.get_mut(index) else {
                continue;
            };

            if record.path_norm != update.path_norm
                || record.modified_secs != update.modified_secs
                || record.file_size != update.file_size
            {
                continue;
            }

            record.target_name = update.target_name.clone();
            record.target_path = update.target_path.clone();
            record.target_norm = update
                .target_name
                .as_deref()
                .map(normalize_for_match)
                .unwrap_or_default();
            applied += 1;
        }

        applied
    }
}

pub(super) struct AtomicFlagGuard<'a> {
    //目标原子标记；drop 时自动重置为 false。
    flag: &'a AtomicBool,
}

impl<'a> AtomicFlagGuard<'a> {
    pub(super) fn new(flag: &'a AtomicBool) -> Self {
        Self { flag }
    }
}

impl Drop for AtomicFlagGuard<'_> {
    fn drop(&mut self) {
        self.flag.store(false, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(path: &str, modified_secs: u64, file_size: u64) -> ShortcutRecord {
        ShortcutRecord {
            item: QuickShortcutItem {
                name: "Demo".to_string(),
                path: path.to_string(),
                source: "desktop_user".to_string(),
            },
            path_norm: path.to_ascii_lowercase(),
            name_norm: "demo".to_string(),
            target_name: None,
            target_path: None,
            target_norm: String::new(),
            modified_secs,
            file_size,
        }
    }

    fn update(path_norm: &str, modified_secs: u64, file_size: u64) -> ResolvedTargetUpdate {
        ResolvedTargetUpdate {
            path_norm: path_norm.to_string(),
            modified_secs,
            file_size,
            target_name: Some("Target".to_string()),
            target_path: Some("C:/Target.exe".to_string()),
        }
    }

    #[test]
    fn replace_records_rebuilds_path_index() {
        let mut state = QuickSearchState::default();
        state.replace_records(vec![
            record("C:/a.lnk", 1, 10),
            record("C:/b.lnk", 1, 10),
        ]);

        assert_eq!(state.record_index.len(), 2);
        assert_eq!(state.record_index.get("c:/b.lnk"), Some(&1));

        // 新快照替换后旧映射不再指向不存在的下标。
        state.replace_records(vec![record("C:/b.lnk", 2, 20)]);
        assert_eq!(state.record_index.len(), 1);
        assert_eq!(state.record_index.get("c:/a.lnk"), None);
    }

    #[test]
    fn apply_target_updates_matches_path_and_metadata() {
        let mut state = QuickSearchState::default();
        state.replace_records(vec![record("C:/a.lnk", 5, 50)]);

        let applied = state.apply_target_updates(&[
            update("c:/a.lnk", 5, 50),
            // 旧 metadata 的迟到结果不得覆盖。
            update("c:/a.lnk", 4, 50),
            // 不存在的路径直接跳过。
            update("c:/missing.lnk", 5, 50),
        ]);

        assert_eq!(applied, 1);
        let record = &state.records[0];
        assert_eq!(record.target_name.as_deref(), Some("Target"));
        assert_eq!(record.target_path.as_deref(), Some("C:/Target.exe"));
        assert_eq!(record.target_norm, normalize_for_match("Target"));
    }
}
