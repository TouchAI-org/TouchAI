// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 隐藏 WebView 会话管理器。
//!
//! 按需创建一个不可见的 WebviewWindow，用于后台浏览网页，
//! 支持页面导航、JS 求值、元素交互和内容提取。
//!
//! 会话空闲 5 分钟后自动销毁，释放系统资源。

use std::sync::Arc;
use std::time::{Duration, Instant};

use log::debug;
use serde_json::Value as JsonValue;
use tokio::sync::{Mutex, oneshot, RwLock};
use tauri::{AppHandle, EventId, Listener, Manager, WebviewUrl, WebviewWindowBuilder};

use super::types::{WebBrowseRequest, WebBrowseResponse};

/// 会话空闲超时：5 分钟。
const SESSION_IDLE_TIMEOUT: Duration = Duration::from_secs(300);
/// 默认单次请求超时（毫秒）。
const DEFAULT_TIMEOUT_MS: u64 = 20_000;
/// 最大请求超时（毫秒）。
const MAX_TIMEOUT_MS: u64 = 60_000;
/// 隐藏 WebView 窗口的固定标签。
const BROWSE_WEBVIEW_LABEL: &str = "hidden-browse-webview";
/// 用于在 JS 和 Rust 之间传递 eval 结果的 Tauri 事件名。
const EVAL_RESULT_EVENT: &str = "__web_browse_eval_result";

/// 单次 JS eval 结果的临时通道。
///
/// 等待期间持有此结构，确保 listener 不会提前注销。
struct EvalResultGuard {
    _listener_id: EventId,
    receiver: oneshot::Receiver<JsonValue>,
}

/// WebView 会话：持有窗口引用、当前 URL 和最后活动时间。
struct WebViewSession {
    window_label: String,
    current_url: Option<String>,
    last_activity: Instant,
}

/// 隐藏 WebView 浏览会话管理器。
///
/// 通过 `tauri::manage()` 注册到应用状态，命令层通过 `State<'_, WebViewSessionManager>` 访问。
pub struct WebViewSessionManager {
    session: RwLock<Option<WebViewSession>>,
    app_handle: AppHandle,
}

impl WebViewSessionManager {
    /// 创建管理器实例，在应用 setup 阶段调用。
    pub fn new(app_handle: AppHandle) -> Self {
        Self {
            session: RwLock::new(None),
            app_handle,
        }
    }

    // ------------------------------------------------------------------
    // 公共入口
    // ------------------------------------------------------------------

    /// 处理一次浏览请求，根据 command 字段分派。
    pub async fn execute(&self, request: WebBrowseRequest) -> Result<WebBrowseResponse, String> {
        let timeout_ms = resolve_timeout(request.timeout_ms);
        match request.command.as_str() {
            "open" => self.cmd_open(request.url, timeout_ms).await,
            "click" => self.cmd_click(request.selector, timeout_ms).await,
            "find" => self.cmd_find(request.selector, timeout_ms).await,
            "scroll" => {
                self.cmd_scroll(request.direction, request.pixels, timeout_ms)
                    .await
            }
            "extract" => self.cmd_extract(request.mode, request.max_chars, timeout_ms).await,
            "evaluate" => self.cmd_evaluate(request.script, timeout_ms).await,
            other => Err(format!("未知的 web_browse 命令: {other}")),
        }
    }

    /// 销毁当前会话（如果存在），通常在应用退出前调用。
    pub async fn destroy(&self) {
        let mut guard = self.session.write().await;
        if let Some(session) = guard.take() {
            if let Some(window) = self.app_handle.get_webview_window(&session.window_label) {
                let _ = window.destroy();
                debug!("WebView 会话已销毁");
            }
        }
    }

    // ------------------------------------------------------------------
    // 命令实现
    // ------------------------------------------------------------------

    /// 打开 URL：确保会话存在，导航到目标地址并等待加载完成。
    async fn cmd_open(
        &self,
        url: Option<String>,
        timeout_ms: u64,
    ) -> Result<WebBrowseResponse, String> {
        let target_url = url.ok_or("open 命令缺少 url 参数")?;
        let window = self.ensure_session().await?;
        self.navigate_and_wait(&window, &target_url, timeout_ms)
            .await
    }

    /// 点击元素：通过 CSS 选择器找到目标并触发点击事件。
    async fn cmd_click(
        &self,
        selector: Option<String>,
        timeout_ms: u64,
    ) -> Result<WebBrowseResponse, String> {
        let sel = selector.ok_or("click 命令缺少 selector 参数")?;
        let window = self.get_active_window()?;
        let escaped = escape_js_string(&sel);
        let js = format!(
            r#"
            (function() {{
                const el = document.querySelector('{escaped}');
                if (!el) throw new Error('未找到匹配元素: {escaped}');
                el.scrollIntoView({{ block: 'center' }});
                el.click();
                return 'clicked';
            }})()
            "#
        );
        self.eval_js_with_result(&window, &js, timeout_ms).await?;
        // 点击后可能触发导航，短暂等待页面稳定。
        self.wait_for_page_stable(&window, timeout_ms).await
    }

    /// 查找元素：返回匹配选择器的元素文本内容。
    async fn cmd_find(
        &self,
        selector: Option<String>,
        timeout_ms: u64,
    ) -> Result<WebBrowseResponse, String> {
        let sel = selector.ok_or("find 命令缺少 selector 参数")?;
        let window = self.get_active_window()?;
        let escaped = escape_js_string(&sel);
        let js = format!(
            r#"
            (function() {{
                const elements = document.querySelectorAll('{escaped}');
                return Array.from(elements).map(el => el.textContent.trim()).filter(Boolean).join('\n');
            }})()
            "#
        );
        let content = self.eval_js_with_result(&window, &js, timeout_ms).await?;
        let current_url = self.get_current_url(&window);
        Ok(WebBrowseResponse {
            current_url,
            content: json_value_to_string(&content),
            title: self.get_page_title(&window),
            truncated: false,
        })
    }

    /// 滚动页面。
    async fn cmd_scroll(
        &self,
        direction: Option<String>,
        pixels: Option<i32>,
        timeout_ms: u64,
    ) -> Result<WebBrowseResponse, String> {
        let dir = direction.unwrap_or_else(|| "down".to_string());
        let px = pixels.unwrap_or(500);
        let window = self.get_active_window()?;
        let (dx, dy) = match dir.as_str() {
            "up" => (0, -px),
            "down" => (0, px),
            "left" => (-px, 0),
            "right" => (px, 0),
            _ => return Err(format!("不支持的滚动方向: {dir}")),
        };
        let js = format!("window.scrollBy({dx}, {dy}); 'scrolled'");
        self.eval_js_with_result(&window, &js, timeout_ms).await?;
        self.wait_for_page_stable(&window, timeout_ms).await
    }

    /// 提取页面内容。
    async fn cmd_extract(
        &self,
        mode: Option<String>,
        max_chars: Option<usize>,
        timeout_ms: u64,
    ) -> Result<WebBrowseResponse, String> {
        let extract_mode = mode.unwrap_or_else(|| "page_text".to_string());
        let window = self.get_active_window()?;

        let js = match extract_mode.as_str() {
            "page_text" => {
                "document.body ? document.body.innerText : document.documentElement.innerText"
            }
            "page_markdown" => {
                // 简易 HTML -> Markdown：保留标题、链接、段落结构。
                r#"
                (function() {
                    function toMarkdown(node, depth) {
                        if (node.nodeType === 3) return node.textContent;
                        if (node.nodeType !== 1) return '';
                        var tag = node.tagName.toLowerCase();
                        var inner = Array.from(node.childNodes).map(function(c) { return toMarkdown(c, depth); }).join('');
                        if (/^h[1-6]$/.test(tag)) {
                            var level = parseInt(tag[1]);
                            return '\n' + '#'.repeat(level) + ' ' + inner.trim() + '\n\n';
                        }
                        if (tag === 'p') return inner.trim() + '\n\n';
                        if (tag === 'br') return '\n';
                        if (tag === 'a') { var href = node.getAttribute('href') || ''; return '[' + inner.trim() + '](' + href + ')'; }
                        if (tag === 'strong' || tag === 'b') return '**' + inner.trim() + '**';
                        if (tag === 'em' || tag === 'i') return '*' + inner.trim() + '*';
                        if (tag === 'code') return '`' + inner.trim() + '`';
                        if (tag === 'pre') return '\n```\n' + inner.trim() + '\n```\n';
                        if (tag === 'li') return '- ' + inner.trim() + '\n';
                        if (tag === 'ul' || tag === 'ol') return '\n' + inner;
                        if (tag === 'img') { var alt = node.getAttribute('alt') || ''; var src = node.getAttribute('src') || ''; return '![' + alt + '](' + src + ')'; }
                        if (['script','style','noscript'].indexOf(tag) !== -1) return '';
                        return inner;
                    }
                    return toMarkdown(document.body, 0).replace(/\n{3,}/g, '\n\n').trim();
                })()
                "#
            }
            "reader" => {
                // 轻量阅读模式：提取 article 标签或 main 区域的文本。
                r#"
                (function() {
                    var article = document.querySelector('article') || document.querySelector('main') || document.body;
                    return article ? article.innerText : '';
                })()
                "#
            }
            other => return Err(format!("不支持的提取模式: {other}")),
        };

        let raw = self.eval_js_with_result(&window, js, timeout_ms).await?;
        let mut text = json_value_to_string(&raw);
        let max = max_chars.unwrap_or(50_000);
        let truncated = text.len() > max;
        if truncated {
            text.truncate(max);
            text.push_str("\n...[截断]");
        }

        Ok(WebBrowseResponse {
            current_url: self.get_current_url(&window),
            content: text,
            title: self.get_page_title(&window),
            truncated,
        })
    }

    /// 执行任意 JS 脚本并返回结果。
    async fn cmd_evaluate(
        &self,
        script: Option<String>,
        timeout_ms: u64,
    ) -> Result<WebBrowseResponse, String> {
        let js = script.ok_or("evaluate 命令缺少 script 参数")?;
        let window = self.get_active_window()?;
        let result = self.eval_js_with_result(&window, &js, timeout_ms).await?;
        Ok(WebBrowseResponse {
            current_url: self.get_current_url(&window),
            content: json_value_to_string(&result),
            title: self.get_page_title(&window),
            truncated: false,
        })
    }

    // ------------------------------------------------------------------
    // 会话生命周期
    // ------------------------------------------------------------------

    /// 确保 WebView 会话存在，空闲超时则重建。
    async fn ensure_session(&self) -> Result<WebviewWindowHandle, String> {
        // 快速路径：会话有效且未过期。
        {
            let guard = self.session.read().await;
            if let Some(ref session) = *guard {
                if session.last_activity.elapsed() < SESSION_IDLE_TIMEOUT {
                    if let Some(window) =
                        self.app_handle.get_webview_window(&session.window_label)
                    {
                        return Ok(WebviewWindowHandle { window });
                    }
                }
            }
        }

        // 慢速路径：需要创建或重建。
        let mut guard = self.session.write().await;
        // 双重检查：其他写者可能已经创建。
        if let Some(ref session) = *guard {
            if session.last_activity.elapsed() < SESSION_IDLE_TIMEOUT {
                if let Some(window) =
                    self.app_handle.get_webview_window(&session.window_label)
                {
                    return Ok(WebviewWindowHandle { window });
                }
            }
        }

        // 销毁旧窗口（如果残留）。
        if let Some(old) = guard.take() {
            if let Some(window) = self.app_handle.get_webview_window(&old.window_label) {
                let _ = window.destroy();
            }
        }

        let handle = self.create_hidden_webview()?;
        *guard = Some(WebViewSession {
            window_label: BROWSE_WEBVIEW_LABEL.to_string(),
            current_url: None,
            last_activity: Instant::now(),
        });
        debug!("WebView 会话已创建");
        Ok(handle)
    }

    /// 创建隐藏的 WebviewWindow。
    fn create_hidden_webview(&self) -> Result<WebviewWindowHandle, String> {
        let window = WebviewWindowBuilder::new(
            &self.app_handle,
            BROWSE_WEBVIEW_LABEL,
            WebviewUrl::External("about:blank".parse().map_err(|_| "无效的 about:blank URL")?),
        )
        .title("TouchAI Browse")
        .inner_size(1280.0, 800.0)
        .visible(false)
        .decorations(false)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .build()
        .map_err(|e| format!("创建隐藏 WebView 失败: {e}"))?;

        // 应用平台相关的 WebView 默认配置（关闭浏览器快捷键等）。
        crate::core::window::webview_defaults::apply_webview_runtime_defaults(&window)?;

        Ok(WebviewWindowHandle { window })
    }

    /// 获取当前活跃的 WebView 窗口。
    fn get_active_window(&self) -> Result<WebviewWindowHandle, String> {
        let guard = self.session.blocking_read();
        let session = guard
            .as_ref()
            .ok_or("WebView 会话不存在，请先执行 open 命令")?;
        let window = self
            .app_handle
            .get_webview_window(&session.window_label)
            .ok_or("WebView 窗口已被销毁，请重新打开")?;

        // 更新活动时间。
        drop(guard);
        let mut guard = self.session.blocking_write();
        if let Some(ref mut s) = *guard {
            s.last_activity = Instant::now();
        }

        Ok(WebviewWindowHandle { window })
    }

    // ------------------------------------------------------------------
    // 导航与 JS 执行
    // ------------------------------------------------------------------

    /// 导航到指定 URL 并等待页面加载完成。
    async fn navigate_and_wait(
        &self,
        handle: &WebviewWindowHandle,
        url: &str,
        timeout_ms: u64,
    ) -> Result<WebBrowseResponse, String> {
        let escaped = escape_js_string(url);
        let nav_js = format!("window.location.assign('{escaped}')");

        // 导航触发是 fire-and-forget，因为 assign() 会替换当前页面。
        handle
            .window
            .eval(&nav_js)
            .map_err(|e| format!("导航失败: {e}"))?;

        // 等待页面加载完成。
        self.wait_for_page_load(handle, url, timeout_ms).await?;

        // 更新会话状态。
        {
            let mut guard = self.session.write().await;
            if let Some(ref mut s) = *guard {
                s.current_url = Some(url.to_string());
                s.last_activity = Instant::now();
            }
        }

        Ok(WebBrowseResponse {
            current_url: url.to_string(),
            content: String::new(),
            title: self.get_page_title(handle),
            truncated: false,
        })
    }

    /// 等待页面加载完成。
    ///
    /// 轮询 `document.readyState`，当值为 "complete" 或 "interactive" 时认为加载完成。
    async fn wait_for_page_load(
        &self,
        handle: &WebviewWindowHandle,
        expected_url_prefix: &str,
        timeout_ms: u64,
    ) -> Result<(), String> {
        let poll_js = r#"
        (function() {
            return JSON.stringify({
                ready: document.readyState,
                url: window.location.href
            });
        })()
        "#;

        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        // 初始等待给页面一些启动时间。
        tokio::time::sleep(Duration::from_millis(300)).await;

        loop {
            if Instant::now() > deadline {
                return Err(format!(
                    "等待页面加载超时 ({}ms)，目标: {expected_url_prefix}",
                    timeout_ms
                ));
            }

            match self.eval_js_with_result(handle, poll_js, 3_000).await {
                Ok(val) => {
                    let json_str = json_value_to_string(&val);
                    if let Ok(info) = serde_json::from_str::<serde_json::Value>(&json_str) {
                        let ready = info["ready"].as_str().unwrap_or("");
                        let current_url = info["url"].as_str().unwrap_or("");
                        // about:blank 在导航到新 URL 之前短暂出现，需要继续等待。
                        if (ready == "complete" || ready == "interactive")
                            && !current_url.starts_with("about:blank")
                        {
                            return Ok(());
                        }
                    }
                }
                Err(e) => {
                    // 页面正在导航中，eval 可能暂时失败，属于正常情况。
                    debug!("轮询加载状态时 eval 失败（可能是导航中）: {e}");
                }
            }

            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    /// 等待页面稳定（点击 / 滚动后短暂等待）。
    async fn wait_for_page_stable(
        &self,
        handle: &WebviewWindowHandle,
        timeout_ms: u64,
    ) -> Result<WebBrowseResponse, String> {
        // 给页面反应时间。
        tokio::time::sleep(Duration::from_millis(500)).await;

        let poll_js = "document.readyState";
        let deadline = Instant::now() + Duration::from_millis(timeout_ms.min(10_000));
        loop {
            if Instant::now() > deadline {
                break;
            }
            match self.eval_js_with_result(handle, poll_js, 2_000).await {
                Ok(val) => {
                    let state = json_value_to_string(&val);
                    if state.contains("complete") || state.contains("interactive") {
                        break;
                    }
                }
                Err(_) => break,
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }

        Ok(WebBrowseResponse {
            current_url: self.get_current_url(handle),
            content: String::new(),
            title: self.get_page_title(handle),
            truncated: false,
        })
    }

    /// 通过事件机制执行 JS 并获取返回值。
    ///
    /// Tauri v2 的 `Window::eval()` 不直接返回结果。
    /// 本方法利用 Tauri 事件系统实现异步结果回传：
    ///
    /// 1. 注册一次性事件监听器；
    /// 2. eval 的 JS 将结果通过 `__TAURI_INTERNALS__.invoke()` 发送回 Rust；
    /// 3. 等待事件到达或超时。
    ///
    /// 外部网页中 Tauri 会注入 `__TAURI_INTERNALS__`，
    /// 但为兼容性，同时使用全局变量作为备选通道。
    async fn eval_js_with_result(
        &self,
        handle: &WebviewWindowHandle,
        js: &str,
        timeout_ms: u64,
    ) -> Result<JsonValue, String> {
        let guard = self.setup_eval_result_listener();

        // 用 try-catch 包装用户脚本，通过事件把结果发回。
        let wrapped_js = format!(
            r#"
            (async function() {{
                try {{
                    const __wb_result = await (async function() {{ {js} }})();
                    // 优先使用 Tauri 事件系统。
                    if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {{
                        await window.__TAURI_INTERNALS__.invoke('plugin:event|emit', {{
                            event: '{EVAL_RESULT_EVENT}',
                            payload: JSON.stringify({{ ok: true, data: __wb_result }})
                        }});
                    }} else {{
                        // 备选：将结果存入全局变量，Rust 侧轮询读取。
                        window.__wb_eval_result = JSON.stringify({{ ok: true, data: __wb_result }});
                    }}
                }} catch(__wb_err) {{
                    if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {{
                        await window.__TAURI_INTERNALS__.invoke('plugin:event|emit', {{
                            event: '{EVAL_RESULT_EVENT}',
                            payload: JSON.stringify({{ ok: false, error: __wb_err.message }})
                        }});
                    }} else {{
                        window.__wb_eval_result = JSON.stringify({{ ok: false, error: __wb_err.message }});
                    }}
                }}
            }})()
            "#
        );

        handle
            .window
            .eval(&wrapped_js)
            .map_err(|e| format!("JS 执行失败: {e}"))?;

        // 等待事件或超时。
        let result = tokio::time::timeout(Duration::from_millis(timeout_ms), guard.receiver).await;

        // 注销监听器。
        handle.window.unlisten(guard._listener_id);

        match result {
            Ok(Ok(payload)) => parse_eval_result(&payload),
            Ok(Err(_)) => {
                // oneshot 被 drop 而未发送，可能是事件系统不可用。
                // 尝试轮询全局变量备选通道。
                self.poll_fallback_result(handle, timeout_ms).await
            }
            Err(_) => Err(format!("JS 执行超时 ({timeout_ms}ms)")),
        }
    }

    /// 设置 eval 结果的事件监听器。
    fn setup_eval_result_listener(&self) -> EvalResultGuard {
        let (tx, rx) = oneshot::channel::<JsonValue>();
        let tx = Arc::new(Mutex::new(Some(tx)));

        let listener_id = self.app_handle.listen(EVAL_RESULT_EVENT, move |event| {
            let payload = event.payload().to_string();
            let value = serde_json::from_str::<JsonValue>(&payload).unwrap_or(JsonValue::Null);
            let tx = tx.clone();
            tokio::spawn(async move {
                let mut guard = tx.lock().await;
                if let Some(sender) = guard.take() {
                    let _ = sender.send(value);
                }
            });
        });

        EvalResultGuard {
            _listener_id: listener_id,
            receiver: rx,
        }
    }

    /// 轮询全局变量 `__wb_eval_result` 作为事件通道的备选方案。
    async fn poll_fallback_result(
        &self,
        handle: &WebviewWindowHandle,
        timeout_ms: u64,
    ) -> Result<JsonValue, String> {
        let poll_js = r#"
        (function() {
            var r = window.__wb_eval_result;
            if (r) { window.__wb_eval_result = null; return r; }
            return null;
        })()
        "#;

        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            if Instant::now() > deadline {
                return Err("轮询 eval 结果超时".to_string());
            }

            // 使用事件机制尝试读取全局变量。
            let result = self.eval_js_with_event(handle, poll_js, 2_000).await;
            if let Ok(val) = result {
                let text = json_value_to_string(&val);
                if text != "null" && !text.is_empty() {
                    let parsed: JsonValue =
                        serde_json::from_str(&text).unwrap_or(JsonValue::String(text.clone()));
                    return parse_eval_result(&parsed);
                }
            }

            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    /// eval_js_with_result 的内部变体，不递归调用轮询。
    async fn eval_js_with_event(
        &self,
        handle: &WebviewWindowHandle,
        js: &str,
        timeout_ms: u64,
    ) -> Result<JsonValue, String> {
        let guard = self.setup_eval_result_listener();

        let wrapped_js = format!(
            r#"
            (async function() {{
                try {{
                    const __wb_result = await (async function() {{ {js} }})();
                    if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {{
                        await window.__TAURI_INTERNALS__.invoke('plugin:event|emit', {{
                            event: '{EVAL_RESULT_EVENT}',
                            payload: JSON.stringify({{ ok: true, data: __wb_result }})
                        }});
                    }} else {{
                        window.__wb_eval_result = JSON.stringify({{ ok: true, data: __wb_result }});
                    }}
                }} catch(__wb_err) {{
                    if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {{
                        await window.__TAURI_INTERNALS__.invoke('plugin:event|emit', {{
                            event: '{EVAL_RESULT_EVENT}',
                            payload: JSON.stringify({{ ok: false, error: __wb_err.message }})
                        }});
                    }} else {{
                        window.__wb_eval_result = JSON.stringify({{ ok: false, error: __wb_err.message }});
                    }}
                }}
            }})()
            "#
        );

        handle
            .window
            .eval(&wrapped_js)
            .map_err(|e| format!("JS 执行失败: {e}"))?;

        let result = tokio::time::timeout(Duration::from_millis(timeout_ms), guard.receiver).await;

        handle.window.unlisten(guard._listener_id);

        match result {
            Ok(Ok(payload)) => parse_eval_result(&payload),
            Ok(Err(_)) => Err("事件通道已关闭".to_string()),
            Err(_) => Err(format!("JS 执行超时 ({timeout_ms}ms)")),
        }
    }

    // ------------------------------------------------------------------
    // 辅助方法
    // ------------------------------------------------------------------

    /// 获取当前页面 URL（从会话缓存中读取）。
    fn get_current_url(&self, _handle: &WebviewWindowHandle) -> String {
        let guard = self.session.blocking_read();
        if let Some(ref session) = *guard {
            if let Some(ref url) = session.current_url {
                return url.clone();
            }
        }
        "unknown".to_string()
    }

    /// 获取页面标题（同步简化版本，返回 None）。
    fn get_page_title(&self, _handle: &WebviewWindowHandle) -> Option<String> {
        None
    }
}

/// WebviewWindow 的轻量包装，避免在整个会话管理器中重复写泛型参数。
struct WebviewWindowHandle {
    window: tauri::WebviewWindow,
}

// ------------------------------------------------------------------
// 辅助函数
// ------------------------------------------------------------------

/// 将 JS 字符串安全地嵌入单引号模板中。
fn escape_js_string(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('\'', "\\'")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
        .replace('\t', "\\t")
}

/// 将 JSON 值转为人类可读的字符串。
fn json_value_to_string(val: &JsonValue) -> String {
    match val {
        JsonValue::String(s) => s.clone(),
        JsonValue::Null => String::new(),
        other => other.to_string(),
    }
}

/// 将超时值限制在合理范围内。
fn resolve_timeout(requested: Option<u64>) -> u64 {
    requested
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .min(MAX_TIMEOUT_MS)
        .max(1_000)
}

/// 解析 eval 结果事件 payload，提取 `data` 或 `error`。
fn parse_eval_result(payload: &JsonValue) -> Result<JsonValue, String> {
    if let Some(true) = payload.get("ok").and_then(|v| v.as_bool()) {
        Ok(payload.get("data").cloned().unwrap_or(JsonValue::Null))
    } else {
        let error = payload
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("未知 JS 错误");
        Err(format!("JS 执行错误: {error}"))
    }
}
