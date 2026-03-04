// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 窗口管理模块
//!
//! 包含主窗口、设置窗口的管理逻辑

pub mod popup;
pub mod resize;
pub mod search;
pub mod settings;
pub mod tray;

pub use search::{hide_search_window, toggle_search_window_visibility};
pub use settings::build_settings_window;
