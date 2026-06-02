// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 系统能力模块。
//!
//! 包含全局快捷键、自启动等系统集成功能。

pub mod assets;
pub mod autostart;
pub mod bundled;
pub mod clipboard;
pub mod desktop_context;
pub mod logging;
pub mod paths;
pub mod runtime;
pub mod shortcut;

mod embedded_rtk {
    include!(concat!(env!("OUT_DIR"), "/rtk-binary.rs"));
}
