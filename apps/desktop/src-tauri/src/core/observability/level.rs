// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! Runtime diagnostic level with a bounded lifetime.

use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use log::{Level, LevelFilter};
use serde::Serialize;

use super::format::OBS_TARGET;

const DIAGNOSTIC_TTL: Duration = Duration::from_secs(30 * 60);

static STARTUP_LEVEL: OnceLock<LevelFilter> = OnceLock::new();
static DIAGNOSTIC_ENABLED: AtomicBool = AtomicBool::new(false);
static EXPIRES_AT_MS: AtomicU64 = AtomicU64::new(0);
static GENERATION: AtomicU64 = AtomicU64::new(0);
/// 当前生效的最高级别，供日志分发层的过滤闭包读取。
///
/// `log::set_max_level` 只影响记录是否被构造，插件的 `Builder::level` 会在
/// fern 分发层再过滤一次；两者不一致时，诊断模式打开的 debug 日志会被分发层
/// 丢掉。因此分发层固定接收 Trace，由这里做唯一判定。
static ACTIVE_LEVEL_RANK: AtomicU8 = AtomicU8::new(RANK_INFO);

const RANK_OFF: u8 = 0;
const RANK_ERROR: u8 = 1;
const RANK_WARN: u8 = 2;
const RANK_INFO: u8 = 3;
const RANK_DEBUG: u8 = 4;
const RANK_TRACE: u8 = 5;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticModeStatus {
    pub enabled: bool,
    pub expires_at_ms: u64,
}

pub(crate) fn initialize(startup_level: LevelFilter) {
    let _ = STARTUP_LEVEL.set(startup_level);
    ACTIVE_LEVEL_RANK.store(rank_of_filter(startup_level), Ordering::SeqCst);
    // 全局上限固定为 Trace：真正的取舍发生在 `allows`，否则诊断模式无法生效。
    log::set_max_level(LevelFilter::Trace);
}

/// 日志分发层的唯一判定：这条记录在当前级别下是否应该落盘。
pub(crate) fn allows(level: Level) -> bool {
    rank_of_level(level) <= ACTIVE_LEVEL_RANK.load(Ordering::SeqCst)
}

fn rank_of_level(level: Level) -> u8 {
    match level {
        Level::Error => RANK_ERROR,
        Level::Warn => RANK_WARN,
        Level::Info => RANK_INFO,
        Level::Debug => RANK_DEBUG,
        Level::Trace => RANK_TRACE,
    }
}

fn rank_of_filter(level: LevelFilter) -> u8 {
    match level {
        LevelFilter::Off => RANK_OFF,
        LevelFilter::Error => RANK_ERROR,
        LevelFilter::Warn => RANK_WARN,
        LevelFilter::Info => RANK_INFO,
        LevelFilter::Debug => RANK_DEBUG,
        LevelFilter::Trace => RANK_TRACE,
    }
}

pub(crate) fn set_diagnostic_mode(enabled: bool) -> DiagnosticModeStatus {
    let startup_level = STARTUP_LEVEL.get().copied().unwrap_or(LevelFilter::Info);
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;

    if enabled {
        DIAGNOSTIC_ENABLED.store(true, Ordering::SeqCst);
        let expires_at_ms = now_ms() + DIAGNOSTIC_TTL.as_millis() as u64;
        EXPIRES_AT_MS.store(expires_at_ms, Ordering::SeqCst);
        ACTIVE_LEVEL_RANK.store(RANK_DEBUG, Ordering::SeqCst);
        log::info!(
            target: OBS_TARGET,
            "obs.diagnostic_mode enabled=true expires_at_ms={expires_at_ms}"
        );
        std::thread::spawn(move || {
            std::thread::sleep(DIAGNOSTIC_TTL);
            if GENERATION.load(Ordering::SeqCst) == generation {
                disable(startup_level);
            }
        });
        status()
    } else {
        disable(startup_level);
        status()
    }
}

fn disable(startup_level: LevelFilter) {
    log::info!(target: OBS_TARGET, "obs.diagnostic_mode enabled=false");
    DIAGNOSTIC_ENABLED.store(false, Ordering::SeqCst);
    EXPIRES_AT_MS.store(0, Ordering::SeqCst);
    ACTIVE_LEVEL_RANK.store(rank_of_filter(startup_level), Ordering::SeqCst);
}

pub(crate) fn status() -> DiagnosticModeStatus {
    let expires_at_ms = EXPIRES_AT_MS.load(Ordering::SeqCst);
    let enabled = DIAGNOSTIC_ENABLED.load(Ordering::SeqCst) && expires_at_ms > now_ms();
    DiagnosticModeStatus {
        enabled,
        expires_at_ms: if enabled { expires_at_ms } else { 0 },
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_gets_an_expiry_when_diagnostic_mode_is_enabled() {
        initialize(LevelFilter::Info);
        let status = set_diagnostic_mode(true);
        assert!(status.enabled);
        assert!(status.expires_at_ms > now_ms());
        set_diagnostic_mode(false);
    }

    #[test]
    fn user_gets_debug_records_only_while_diagnostic_mode_is_enabled() {
        initialize(LevelFilter::Info);
        set_diagnostic_mode(false);

        assert!(allows(Level::Info));
        assert!(!allows(Level::Debug));

        set_diagnostic_mode(true);
        assert!(allows(Level::Debug));

        set_diagnostic_mode(false);
        assert!(!allows(Level::Debug));
    }
}
