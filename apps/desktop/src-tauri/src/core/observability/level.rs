// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! Runtime diagnostic level with a bounded lifetime.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use log::LevelFilter;
use serde::Serialize;

use super::format::OBS_TARGET;

const DIAGNOSTIC_TTL: Duration = Duration::from_secs(30 * 60);

static STARTUP_LEVEL: OnceLock<LevelFilter> = OnceLock::new();
static DIAGNOSTIC_ENABLED: AtomicBool = AtomicBool::new(false);
static EXPIRES_AT_MS: AtomicU64 = AtomicU64::new(0);
static GENERATION: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticModeStatus {
    pub enabled: bool,
    pub expires_at_ms: u64,
}

pub(crate) fn initialize(startup_level: LevelFilter) {
    let _ = STARTUP_LEVEL.set(startup_level);
}

pub(crate) fn set_diagnostic_mode(enabled: bool) -> DiagnosticModeStatus {
    let startup_level = STARTUP_LEVEL.get().copied().unwrap_or(LevelFilter::Info);
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;

    if enabled {
        DIAGNOSTIC_ENABLED.store(true, Ordering::SeqCst);
        let expires_at_ms = now_ms() + DIAGNOSTIC_TTL.as_millis() as u64;
        EXPIRES_AT_MS.store(expires_at_ms, Ordering::SeqCst);
        log::set_max_level(LevelFilter::Debug);
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
    log::set_max_level(startup_level);
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
}
