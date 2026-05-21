// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 弹窗核心模块。

pub mod manager;
pub mod registry;

pub use manager::{hide_popup_window, is_app_focused, preload_popup_windows, show_popup_window};
pub use registry::{PopupConfig, PopupRegistry};
