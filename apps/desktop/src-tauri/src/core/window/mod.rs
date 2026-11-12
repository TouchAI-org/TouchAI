// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 窗口管理模块
//!
//! 包含主窗口、设置窗口的管理逻辑

pub mod computer_use_glow;
pub mod resize;
pub mod rounded_corners;
pub mod search;
pub mod search_host;
pub mod search_region;
pub mod settings;
pub mod status_reminder;
pub mod tray;
#[cfg(target_os = "linux")]
pub(crate) mod webkit_cors;
pub(crate) mod webview_defaults;
pub(crate) mod webview_recovery;

/// Transparent room reserved around floating windows for their CSS shadow.
pub(crate) const WINDOW_SHADOW_GUTTER: f64 = 24.0;

pub use search::{
    hide_search_window_on_main_thread, show_search_window_for_testing_on_main_thread,
    show_search_window_from_shortcut_on_main_thread, show_search_window_on_main_thread,
};
pub use settings::build_settings_window;
