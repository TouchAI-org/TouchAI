// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//manager 调度层共享状态定义。
//!
//存放索引记录、刷新状态与后台任务通信载体类型。

use crate::core::search::types::QuickShortcutItem;
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};

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
            next_refresh_after: None,
        }
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
