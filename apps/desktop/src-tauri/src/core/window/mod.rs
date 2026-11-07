// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 窗口管理模块
//!
//! 包含主窗口、设置窗口的管理逻辑

pub mod resize;
pub mod rounded_corners;
pub mod search;
pub mod search_host;
pub mod search_region;
pub mod settings;
pub mod status_reminder;
pub mod tray;
pub(crate) mod webview_defaults;
pub(crate) mod webview_recovery;

pub use search::{
    hide_search_window_on_main_thread, show_search_window_for_testing_on_main_thread,
    show_search_window_from_shortcut_on_main_thread, show_search_window_on_main_thread,
};
pub use settings::build_settings_window;

#[cfg(test)]
mod tests {
    #[test]
    fn ui_thread_callbacks_do_not_synchronously_redispatch_to_the_ui_queue() {
        let blocking_dispatch = ["run_on_main_thread", "_and_wait"].concat();
        for (name, source) in [
            ("window commands", include_str!("../../commands/window.rs")),
            ("search surface", include_str!("search/surface.rs")),
        ] {
            assert!(
                !source.contains(&blocking_dispatch),
                "{name} must call its _on_main_thread implementation directly"
            );
        }

        let shortcut_source = include_str!("../system/shortcut.rs");
        assert!(
            !shortcut_source.contains("run_on_main_thread("),
            "the global-shortcut callback already runs on the UI thread"
        );
    }

    #[test]
    fn windows_main_blur_checks_the_foreground_hwnd_family() {
        let source = include_str!("search/surface.rs");
        for required_contract in [
            "GetForegroundWindow",
            "GA_ROOT",
            "GA_ROOTOWNER",
            "foreground_belongs_to_main_hwnd_family",
        ] {
            assert!(
                source.contains(required_contract),
                "search blur handling must use {required_contract}"
            );
        }
    }

    #[test]
    fn native_hide_uses_a_rollback_state_transaction() {
        let source = include_str!("search/surface.rs");
        assert!(
            source.contains("hide_surface_state_transaction"),
            "native hide failures must restore the previous search protocol state"
        );
    }

    #[test]
    fn win32_region_failures_capture_last_error_before_cleanup() {
        for (name, source) in [
            ("search regions", include_str!("search_region.rs")),
            ("rounded corners", include_str!("rounded_corners.rs")),
        ] {
            let capture = source
                .find("let error = windows::core::Error::from_thread();")
                .unwrap_or_else(|| panic!("{name} must capture the Win32 error"));
            let cleanup = source[capture..]
                .find("DeleteObject")
                .unwrap_or_else(|| panic!("{name} must clean up its failed region"));
            assert!(
                cleanup > 0,
                "{name} must capture the Win32 error before cleanup"
            );
        }
    }
}
