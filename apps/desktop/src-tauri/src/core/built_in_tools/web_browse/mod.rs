// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 隐藏 WebView 浏览模块。

mod commands;
mod session;
mod types;

pub use commands::execute_browse_command;
pub use session::WebViewSessionManager;
pub use types::{WebBrowseRequest, WebBrowseResponse};
