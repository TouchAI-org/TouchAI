// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 运行时模式与环境开关。

use std::path::PathBuf;

const TOUCHAI_APP_ROOT_ENV: &str = "TOUCHAI_APP_ROOT";
const TOUCHAI_E2E_ENV: &str = "TOUCHAI_E2E";
const TOUCHAI_E2E_DISABLE_SINGLE_INSTANCE_ENV: &str = "TOUCHAI_E2E_DISABLE_SINGLE_INSTANCE";
const TOUCHAI_UI_PREVIEW_ENV: &str = "TOUCHAI_UI_PREVIEW";

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    pub is_e2e_test_mode: bool,
    pub is_ui_preview_mode: bool,
}

impl RuntimeInfo {
    pub fn current() -> Self {
        Self {
            is_e2e_test_mode: is_e2e_test_mode(),
            is_ui_preview_mode: is_ui_preview_mode(),
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

pub fn can_show_startup_failure_dialog() -> bool {
    if is_e2e_test_mode() {
        return false;
    }

    #[cfg(target_os = "linux")]
    {
        has_linux_display(
            std::env::var_os("DISPLAY"),
            std::env::var_os("WAYLAND_DISPLAY"),
        )
    }
    #[cfg(not(target_os = "linux"))]
    {
        true
    }
}

#[cfg(any(target_os = "linux", test))]
fn has_linux_display(
    display: Option<std::ffi::OsString>,
    wayland_display: Option<std::ffi::OsString>,
) -> bool {
    display
        .into_iter()
        .chain(wayland_display)
        .any(|address| !address.is_empty())
}

/// The preview records a fixed-size, centered window. Content-driven resizes
/// would move the window while the viewer is reading it, so they are disabled
/// in this mode and the recorder sets the window frame once before capture.
pub fn is_ui_preview_mode() -> bool {
    matches!(
        std::env::var(TOUCHAI_UI_PREVIEW_ENV)
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

/// Browser arguments for every WebView2 window outside E2E mode.
///
/// Chromium throttles timers, renderers and occlusion for windows that are not
/// focused or are covered. A launcher is covered most of its life, so those
/// defaults make the first frame after a shortcut slow. Raycast keeps Chromium
/// from throttling its WebView for the same reason; these are the equivalent
/// WebView2 switches.
///
/// The first window creates the shared WebView2 environment, so every window
/// creation path must pass an identical value. Providing arguments replaces
/// wry's defaults, hence `msWebOOUI`, `msPdfOOUI` and `msSmartScreenProtection`
/// are repeated here.
#[cfg(target_os = "windows")]
const DEFAULT_PRODUCTION_WEBVIEW_ADDITIONAL_BROWSER_ARGS: &str = concat!(
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion ",
    "--disable-background-timer-throttling ",
    "--disable-backgrounding-occluded-windows ",
    "--disable-renderer-backgrounding"
);

/// Browser arguments applied to the shared WebView2 environment.
/// `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` still wins, matching wry's behavior.
#[cfg(target_os = "windows")]
pub fn webview_additional_browser_args() -> Option<String> {
    if is_e2e_test_mode() {
        return e2e_webview_additional_browser_args();
    }
    if let Ok(configured) = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") {
        let trimmed = configured.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    Some(DEFAULT_PRODUCTION_WEBVIEW_ADDITIONAL_BROWSER_ARGS.to_string())
}

#[cfg(not(target_os = "windows"))]
pub fn webview_additional_browser_args() -> Option<String> {
    None
}

pub fn should_enable_single_instance() -> bool {
    !is_e2e_test_mode()
        && !matches!(
            std::env::var(TOUCHAI_E2E_DISABLE_SINGLE_INSTANCE_ENV)
                .ok()
                .map(|value| value.trim().to_ascii_lowercase())
                .as_deref(),
            Some("1" | "true" | "yes" | "on")
        )
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
        can_show_startup_failure_dialog, e2e_webview_additional_browser_args, has_linux_display,
        is_e2e_test_mode, is_ui_preview_mode, should_enable_single_instance,
        webview_additional_browser_args, DEFAULT_E2E_WEBVIEW_ADDITIONAL_BROWSER_ARGS,
        TOUCHAI_E2E_DISABLE_SINGLE_INSTANCE_ENV, TOUCHAI_E2E_ENV, TOUCHAI_UI_PREVIEW_ENV,
    };
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn user_does_not_wait_for_a_startup_dialog_when_e2e_mode_is_enabled() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        for value in ["1", "true", "YES", " on "] {
            std::env::set_var(TOUCHAI_E2E_ENV, value);
            assert!(!can_show_startup_failure_dialog(), "E2E value: {value}");
        }
        std::env::remove_var(TOUCHAI_E2E_ENV);
    }

    #[cfg(not(target_os = "linux"))]
    #[test]
    fn user_can_see_a_startup_dialog_when_launching_interactively_on_a_native_desktop() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        std::env::remove_var(TOUCHAI_E2E_ENV);

        assert!(can_show_startup_failure_dialog());
    }

    #[test]
    fn user_cannot_see_a_linux_dialog_when_both_display_addresses_are_absent_or_empty() {
        assert!(!has_linux_display(None, None));
        assert!(!has_linux_display(Some("".into()), Some("".into())));
        assert!(!has_linux_display(Some("".into()), None));
        assert!(!has_linux_display(None, Some("".into())));
    }

    #[test]
    fn user_can_see_a_linux_dialog_when_either_display_protocol_is_available() {
        assert!(has_linux_display(Some(":99".into()), None));
        assert!(has_linux_display(None, Some("wayland-0".into())));
        assert!(has_linux_display(Some("".into()), Some("wayland-0".into())));
        assert!(has_linux_display(Some(":99".into()), Some("".into())));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn user_keeps_wry_defaults_and_anti_throttling_in_production_mode() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        std::env::remove_var(TOUCHAI_E2E_ENV);
        std::env::remove_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS");

        let args = webview_additional_browser_args().expect("production args");
        assert!(args.contains("msWebOOUI"));
        assert!(args.contains("msPdfOOUI"));
        assert!(args.contains("msSmartScreenProtection"));
        assert!(args.contains("CalculateNativeWinOcclusion"));
        assert!(args.contains("--disable-background-timer-throttling"));
        assert!(args.contains("--disable-backgrounding-occluded-windows"));
        assert!(args.contains("--disable-renderer-backgrounding"));
    }

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

    #[test]
    fn user_can_disable_single_instance_without_enabling_e2e_mode() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        std::env::remove_var(TOUCHAI_E2E_ENV);
        std::env::remove_var(TOUCHAI_E2E_DISABLE_SINGLE_INSTANCE_ENV);

        assert!(should_enable_single_instance());

        for value in ["1", "true", "YES", " on "] {
            std::env::set_var(TOUCHAI_E2E_DISABLE_SINGLE_INSTANCE_ENV, value);
            assert!(!should_enable_single_instance(), "disable value: {value}");
        }

        std::env::set_var(TOUCHAI_E2E_DISABLE_SINGLE_INSTANCE_ENV, "0");
        assert!(should_enable_single_instance());

        std::env::set_var(TOUCHAI_E2E_ENV, "1");
        assert!(!should_enable_single_instance());

        std::env::remove_var(TOUCHAI_E2E_ENV);
        std::env::remove_var(TOUCHAI_E2E_DISABLE_SINGLE_INSTANCE_ENV);
    }

    #[test]
    fn ui_preview_mode_accepts_the_same_truthy_values_as_e2e_mode() {
        let _guard = ENV_LOCK.lock().expect("env lock");

        for value in ["1", "true", "YES", " on "] {
            std::env::set_var(TOUCHAI_UI_PREVIEW_ENV, value);
            assert!(is_ui_preview_mode(), "{value:?} should enable preview mode");
        }

        std::env::set_var(TOUCHAI_UI_PREVIEW_ENV, "0");
        assert!(!is_ui_preview_mode());
        std::env::remove_var(TOUCHAI_UI_PREVIEW_ENV);
    }

    #[test]
    fn user_preview_mode_keeps_session_reminders_in_process() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        std::env::remove_var(TOUCHAI_E2E_ENV);
        std::env::set_var(TOUCHAI_UI_PREVIEW_ENV, "1");

        let runtime =
            crate::core::window::status_reminder::SessionStatusReminderNotificationRuntime::new();

        assert!(runtime.is_test_mode());
        std::env::remove_var(TOUCHAI_UI_PREVIEW_ENV);
    }
}
