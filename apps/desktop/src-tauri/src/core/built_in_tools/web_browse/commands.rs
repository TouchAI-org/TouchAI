// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! WebView 浏览命令：薄封装层。
//!
//! 将 Tauri command 参数校验、状态注入统一收口于此，
//! 实际执行逻辑委托给 WebViewSessionManager。

use super::session::WebViewSessionManager;
use super::types::{WebBrowseRequest, WebBrowseResponse};

/// 执行一次 WebView 浏览命令。
///
/// 命令层不做重复逻辑，直接转发到会话管理器。
pub async fn execute_browse_command(
    request: WebBrowseRequest,
    manager: &WebViewSessionManager,
) -> Result<WebBrowseResponse, String> {
    manager.execute(request).await
}
