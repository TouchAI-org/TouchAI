// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 运行时模式与环境开关。

use std::path::PathBuf;

const TOUCHAI_APP_ROOT_ENV: &str = "TOUCHAI_APP_ROOT";
const TOUCHAI_E2E_ENV: &str = "TOUCHAI_E2E";

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    pub is_e2e_test_mode: bool,
}

impl RuntimeInfo {
    pub fn current() -> Self {
        Self {
            is_e2e_test_mode: is_e2e_test_mode(),
        }
    }
}

pub fn is_e2e_test_mode() -> bool {
    matches!(
        std::env::var(TOUCHAI_E2E_ENV)
            .ok()
            .map(|value| value.trim().to_ascii_lowercase())
            .as_deref(),
        Some("1" | "true" | "yes" | "on")
    )
}

/// WebView2 browser arguments applied only in E2E mode.
///
/// wry defaults to `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection`.
/// Providing `additional_browser_args` replaces that default, so keep those flags.
/// GitHub Windows runners with WebView2 150+ also need remote debugging for
/// tauri-driver/msedgedriver session creation (DevToolsActivePort).
pub fn e2e_webview_additional_browser_args() -> Option<String> {
    if !is_e2e_test_mode() {
        return None;
    }

    if let Ok(configured) = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") {
        let trimmed = configured.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }

    Some(DEFAULT_E2E_WEBVIEW_ADDITIONAL_BROWSER_ARGS.to_string())
}

const DEFAULT_E2E_WEBVIEW_ADDITIONAL_BROWSER_ARGS: &str = concat!(
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection ",
    "--remote-debugging-port=9222 ",
    "--enable-features=msEdgeDevToolsWdpRemoteDebugging ",
    "--no-sandbox ",
    "--disable-gpu ",
    "--disable-dev-shm-usage"
);

pub fn should_enable_single_instance() -> bool {
    !is_e2e_test_mode()
}

pub fn resolve_app_root_override() -> Option<PathBuf> {
    std::env::var(TOUCHAI_APP_ROOT_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::{
        e2e_webview_additional_browser_args, is_e2e_test_mode,
        DEFAULT_E2E_WEBVIEW_ADDITIONAL_BROWSER_ARGS, TOUCHAI_E2E_ENV,
    };
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn e2e_browser_args_are_none_outside_e2e_mode() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        std::env::remove_var(TOUCHAI_E2E_ENV);
        std::env::remove_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS");

        assert!(!is_e2e_test_mode());
        assert_eq!(e2e_webview_additional_browser_args(), None);
    }

    #[test]
    fn e2e_browser_args_use_default_remote_debugging_flags_in_e2e_mode() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        std::env::set_var(TOUCHAI_E2E_ENV, "1");
        std::env::remove_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS");

        let args = e2e_webview_additional_browser_args().expect("args");
        assert_eq!(args, DEFAULT_E2E_WEBVIEW_ADDITIONAL_BROWSER_ARGS);
        assert!(args.contains("--remote-debugging-port=9222"));
        assert!(args.contains("msWebOOUI"));
        assert!(args.contains("msEdgeDevToolsWdpRemoteDebugging"));

        std::env::remove_var(TOUCHAI_E2E_ENV);
    }

    #[test]
    fn e2e_browser_args_prefer_explicit_env_override() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        std::env::set_var(TOUCHAI_E2E_ENV, "1");
        std::env::set_var(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "--remote-debugging-port=9333",
        );

        assert_eq!(
            e2e_webview_additional_browser_args().as_deref(),
            Some("--remote-debugging-port=9333")
        );

        std::env::remove_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS");
        std::env::remove_var(TOUCHAI_E2E_ENV);
    }
}
