// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! WebView 浏览请求 / 响应类型。

use serde::{Deserialize, Serialize};

/// WebView 浏览请求。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebBrowseRequest {
    /// 浏览命令: open, click, find, scroll, extract, evaluate.
    pub command: String,
    /// open 命令的目标 URL。
    #[serde(default)]
    pub url: Option<String>,
    /// click / find 命令的 CSS 选择器或文本内容。
    #[serde(default)]
    pub selector: Option<String>,
    /// scroll 命令的方向: up, down, left, right.
    #[serde(default)]
    pub direction: Option<String>,
    /// scroll 命令的滚动距离（像素）。
    #[serde(default)]
    pub pixels: Option<i32>,
    /// extract 命令的提取模式: reader, page_markdown, page_text.
    #[serde(default)]
    pub mode: Option<String>,
    /// extract 命令的最大输出字符数。
    #[serde(default)]
    pub max_chars: Option<usize>,
    /// evaluate 命令的 JS 脚本。
    #[serde(default)]
    pub script: Option<String>,
    /// 请求超时（毫秒），默认 20000。
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

/// WebView 浏览响应。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebBrowseResponse {
    /// 命令执行后的页面 URL。
    pub current_url: String,
    /// 命令返回的内容（HTML、匹配结果、JS 求值结果等）。
    pub content: String,
    /// 页面标题。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// 是否因内容过大被截断。
    #[serde(default)]
    pub truncated: bool,
}
