use std::{
    collections::hash_map::DefaultHasher,
    collections::BTreeMap,
    fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    sync::OnceLock,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use base64::Engine;
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{protocol::WebSocketConfig, Message},
};

use super::{
    actions::BrowserResolvedAction,
    endpoint::{validate_loopback_websocket, validate_stale_navigation_token, BrowserEndpoint},
    types::{BrowserActOperation, BrowserActResult, BrowserDomRef, BrowserTab},
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CdpTarget {
    id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    url: String,
    #[serde(default, rename = "type")]
    target_type: String,
    #[serde(default, rename = "webSocketDebuggerUrl")]
    web_socket_debugger_url: Option<String>,
}

#[derive(Debug)]
pub struct PageSnapshot {
    pub url: Option<String>,
    pub title: Option<String>,
    pub navigation_token: Option<String>,
    pub refs: Vec<BrowserDomRef>,
    pub file_path: Option<PathBuf>,
    pub mime_type: Option<String>,
    pub console: Vec<String>,
    pub network: Vec<String>,
}

const MAX_DIAGNOSTIC_ENTRIES: usize = 30;
const MAX_DIAGNOSTIC_ENTRY_BYTES: usize = 2048;
const MAX_DIAGNOSTIC_TOTAL_BYTES: usize = 16 * 1024;
const MAX_DIAGNOSTIC_ARG_BYTES: usize = 512;
const MAX_DIAGNOSTIC_ARGS: usize = 8;
const MAX_CDP_DIAGNOSTIC_MESSAGE_BYTES: usize = 64 * 1024;
const MAX_CDP_HTTP_BODY_BYTES: usize = 256 * 1024;
const MAX_TRACKED_REQUEST_URLS: usize = 200;
const SCREENSHOT_ARTIFACT_PREFIX: &str = "browser-screenshot-";
const MAX_SCREENSHOT_ARTIFACTS: usize = 50;
const MAX_SCREENSHOT_ARTIFACT_BYTES: usize = 5 * 1024 * 1024;
const MAX_SCREENSHOT_ARTIFACT_BASE64_BYTES: usize = ((MAX_SCREENSHOT_ARTIFACT_BYTES + 2) / 3) * 4;
const MAX_CDP_COMMAND_MESSAGE_BYTES: usize = MAX_SCREENSHOT_ARTIFACT_BASE64_BYTES + 256 * 1024;
const SCREENSHOT_ARTIFACT_TTL: Duration = Duration::from_secs(60 * 60);
const TRUNCATED_SUFFIX: &str = " ...[truncated]";
#[cfg(target_os = "macos")]
const SELECT_ALL_MODIFIER: i32 = 4;
#[cfg(not(target_os = "macos"))]
const SELECT_ALL_MODIFIER: i32 = 2;

#[derive(Debug)]
struct FocusedEditableElement {
    tag: String,
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(4))
        .build()
        .map_err(|error| format!("Failed to build browser endpoint client: {error}"))
}

fn navigation_token(tab: &CdpTarget) -> String {
    let mut hasher = DefaultHasher::new();
    tab.id.hash(&mut hasher);
    tab.url.hash(&mut hasher);
    tab.title.hash(&mut hasher);
    format!("nav-{:016x}", hasher.finish())
}

impl CdpTarget {
    fn to_tab(&self, active: bool) -> BrowserTab {
        BrowserTab {
            id: self.id.clone(),
            url: self.url.clone(),
            title: self.title.clone(),
            active,
            navigation_token: navigation_token(self),
        }
    }
}

pub async fn list_targets(endpoint: &BrowserEndpoint) -> Result<Vec<CdpTarget>, String> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(4))
        .build()
        .map_err(|error| format!("Failed to build browser endpoint client: {error}"))?;

    client
        .get(endpoint.list_url())
        .send()
        .await
        .map_err(|error| format!("Failed to list browser tabs: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Browser tab listing returned an error: {error}"))?
        .bytes()
        .await
        .map_err(|error| format!("Failed to read browser tab listing: {error}"))
        .and_then(|bytes| {
            parse_bounded_json_bytes(&bytes, MAX_CDP_HTTP_BODY_BYTES, "browser tab listing")
        })
        .map_err(|error| format!("Browser tab listing was invalid: {error}"))
}

pub async fn list_tabs(
    endpoint: &BrowserEndpoint,
    active_tab_id: Option<&str>,
) -> Result<Vec<BrowserTab>, String> {
    let targets = list_targets(endpoint).await?;
    let page_targets: Vec<CdpTarget> = targets
        .into_iter()
        .filter(|target| target.target_type == "page")
        .collect();
    let active = active_tab_id
        .filter(|id| page_targets.iter().any(|target| target.id == *id))
        .map(str::to_string)
        .or_else(|| page_targets.first().map(|target| target.id.clone()));

    Ok(page_targets
        .iter()
        .map(|target| target.to_tab(active.as_deref() == Some(target.id.as_str())))
        .collect())
}

pub async fn create_tab(endpoint: &BrowserEndpoint, url: &str) -> Result<(), String> {
    let client = http_client()?;
    client
        .put(endpoint.new_tab_url(url))
        .send()
        .await
        .map_err(|error| format!("Failed to create browser tab: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Browser tab creation returned an error: {error}"))?;
    Ok(())
}

pub async fn observe_page(
    endpoint: &BrowserEndpoint,
    tab_id: Option<&str>,
    include_dom: bool,
    include_screenshot: bool,
    include_console: bool,
    include_network: bool,
) -> Result<PageSnapshot, String> {
    let target = resolve_page_target(endpoint, tab_id).await?;
    let navigation_token = navigation_token(&target);
    let refs = if include_dom {
        let value = call_page(
            endpoint,
            &target,
            "Runtime.evaluate",
            json!({
                "expression": DOM_REF_SCRIPT,
                "returnByValue": true,
                "awaitPromise": true
            }),
        )
        .await?;
        parse_dom_refs(value, &navigation_token)?
    } else {
        Vec::new()
    };

    let screenshot_base64 = if include_screenshot {
        let value = call_page(
            endpoint,
            &target,
            "Page.captureScreenshot",
            json!({
                "format": "png",
                "captureBeyondViewport": false
            }),
        )
        .await?;
        value
            .get("data")
            .and_then(Value::as_str)
            .map(str::to_string)
    } else {
        None
    };
    let file_path = screenshot_base64
        .as_deref()
        .map(write_screenshot_artifact)
        .transpose()?;
    let diagnostics =
        collect_page_diagnostics(endpoint, &target, include_console, include_network).await?;

    Ok(PageSnapshot {
        url: Some(target.url),
        title: Some(target.title),
        navigation_token: Some(navigation_token),
        refs,
        file_path,
        mime_type: if include_screenshot {
            Some("image/png".to_string())
        } else {
            None
        },
        console: diagnostics.console,
        network: diagnostics.network,
    })
}

pub async fn navigate_current_page(
    endpoint: &BrowserEndpoint,
    tab_id: Option<&str>,
    url: &str,
) -> Result<(), String> {
    let target = resolve_page_target(endpoint, tab_id).await?;
    call_page(endpoint, &target, "Page.navigate", json!({ "url": url })).await?;
    Ok(())
}

pub async fn apply_page_fingerprint_overrides(
    endpoint: &BrowserEndpoint,
    tab_id: Option<&str>,
    locale: Option<&str>,
    timezone: Option<&str>,
    stealth_script: bool,
) -> Result<(), String> {
    if locale.is_none() && timezone.is_none() && !stealth_script {
        return Ok(());
    }
    let target = resolve_page_target(endpoint, tab_id).await?;
    if stealth_script {
        let script = browser_fingerprint_compat_script(locale);
        call_page(
            endpoint,
            &target,
            "Page.addScriptToEvaluateOnNewDocument",
            json!({ "source": script }),
        )
        .await?;
        call_page(
            endpoint,
            &target,
            "Runtime.evaluate",
            json!({
                "expression": script,
                "awaitPromise": false,
                "returnByValue": true
            }),
        )
        .await?;
    }
    if let Some(locale) = locale.and_then(normalized_override_value) {
        call_page(
            endpoint,
            &target,
            "Emulation.setLocaleOverride",
            json!({ "locale": locale }),
        )
        .await?;
    }
    if let Some(timezone) = timezone.and_then(normalized_override_value) {
        call_page(
            endpoint,
            &target,
            "Emulation.setTimezoneOverride",
            json!({ "timezoneId": timezone }),
        )
        .await?;
    }
    Ok(())
}

fn normalized_override_value(value: &str) -> Option<&str> {
    let value = value.trim();
    (!value.is_empty() && !value.starts_with('-') && !value.contains('\0')).then_some(value)
}

fn browser_fingerprint_compat_script(locale: Option<&str>) -> String {
    let locale = locale
        .and_then(normalized_override_value)
        .unwrap_or("zh-CN")
        .to_string();
    let language = locale
        .split(['-', '_'])
        .next()
        .filter(|value| !value.is_empty())
        .unwrap_or("zh")
        .to_string();
    let locale_json = serde_json::to_string(&locale).unwrap_or_else(|_| "\"zh-CN\"".to_string());
    let language_json = serde_json::to_string(&language).unwrap_or_else(|_| "\"zh\"".to_string());
    format!(
        r#"
(() => {{
  if (globalThis.__touchaiFingerprintCompatInstalled) return true;
  Object.defineProperty(globalThis, '__touchaiFingerprintCompatInstalled', {{ value: true, configurable: false }});
  const safeDefine = (target, prop, getter) => {{
    try {{ Object.defineProperty(target, prop, {{ get: getter, configurable: true }}); }} catch {{}}
  }};
  const navProto = Navigator.prototype;
  safeDefine(navProto, 'webdriver', () => undefined);
  safeDefine(navProto, 'languages', () => [{locale_json}, {language_json}]);
  safeDefine(navProto, 'language', () => {locale_json});
  safeDefine(navProto, 'platform', () => 'Win32');
  safeDefine(navProto, 'hardwareConcurrency', () => 8);
  safeDefine(navProto, 'deviceMemory', () => 8);
  const fakePluginArray = (() => {{
    const plugins = [
      {{ name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' }},
      {{ name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' }},
      {{ name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' }},
      {{ name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' }},
      {{ name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: 'Portable Document Format' }},
    ];
    plugins.item = (index) => plugins[index] || null;
    plugins.namedItem = (name) => plugins.find((plugin) => plugin.name === name) || null;
    plugins.refresh = () => undefined;
    return plugins;
  }})();
  const fakeMimeTypes = (() => {{
    const mimeTypes = [{{ type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' }}];
    mimeTypes.item = (index) => mimeTypes[index] || null;
    mimeTypes.namedItem = (name) => mimeTypes.find((item) => item.type === name) || null;
    return mimeTypes;
  }})();
  safeDefine(navProto, 'plugins', () => fakePluginArray);
  safeDefine(navProto, 'mimeTypes', () => fakeMimeTypes);
  globalThis.chrome = globalThis.chrome || {{}};
  globalThis.chrome.runtime = globalThis.chrome.runtime || {{}};
  if (navigator.permissions && navigator.permissions.query) {{
    const originalQuery = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (parameters) => {{
      if (parameters && parameters.name === 'notifications') {{
        return Promise.resolve({{ state: Notification.permission }});
      }}
      return originalQuery(parameters);
    }};
  }}
  const patchWebGL = (proto) => {{
    if (!proto || !proto.getParameter || proto.__touchaiCompatPatched) return;
    const original = proto.getParameter;
    Object.defineProperty(proto, '__touchaiCompatPatched', {{ value: true }});
    proto.getParameter = function(parameter) {{
      if (parameter === 37445) return 'Intel Inc.';
      if (parameter === 37446) return 'Intel(R) UHD Graphics';
      return original.call(this, parameter);
    }};
  }};
  patchWebGL(globalThis.WebGLRenderingContext && WebGLRenderingContext.prototype);
  patchWebGL(globalThis.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
  const patchCanvas = (proto) => {{
    if (!proto || !proto.toDataURL || proto.__touchaiCompatPatched) return;
    const originalToDataURL = proto.toDataURL;
    Object.defineProperty(proto, '__touchaiCompatPatched', {{ value: true }});
    proto.toDataURL = function(...args) {{
      try {{
        const ctx = this.getContext && this.getContext('2d');
        if (ctx && this.width > 0 && this.height > 0) {{
          const image = ctx.getImageData(0, 0, 1, 1);
          image.data[0] = (image.data[0] + 1) % 255;
          ctx.putImageData(image, 0, 0);
        }}
      }} catch {{}}
      return originalToDataURL.apply(this, args);
    }};
  }};
  patchCanvas(globalThis.HTMLCanvasElement && HTMLCanvasElement.prototype);
  return true;
}})()
"#
    )
}

pub async fn history_action(
    endpoint: &BrowserEndpoint,
    tab_id: Option<&str>,
    action: &str,
) -> Result<(), String> {
    let target = resolve_page_target(endpoint, tab_id).await?;
    let method = match action {
        "back" => "history.back()",
        "forward" => "history.forward()",
        "reload" => "location.reload()",
        _ => return Err(format!("Unsupported browser history action: {action}")),
    };
    call_page(
        endpoint,
        &target,
        "Runtime.evaluate",
        json!({
            "expression": method,
            "awaitPromise": false,
            "returnByValue": true
        }),
    )
    .await?;
    Ok(())
}

pub async fn dispatch_action(
    endpoint: &BrowserEndpoint,
    tab_id: Option<&str>,
    request: &super::types::BrowserActRequest,
    resolved_action: BrowserResolvedAction<'_>,
) -> Result<BrowserActResult, String> {
    let target = resolve_page_target(endpoint, tab_id).await?;
    let current_navigation_token = navigation_token(&target);
    revalidate_resolved_action(&resolved_action, &current_navigation_token)?;

    match request.action {
        BrowserActOperation::Click => click(endpoint, &target, resolved_action.reference).await?,
        BrowserActOperation::Type => {
            type_text(endpoint, &target, request, resolved_action.reference, false).await?
        }
        BrowserActOperation::Fill => {
            type_text(endpoint, &target, request, resolved_action.reference, true).await?
        }
        BrowserActOperation::FillForm => fill_form(endpoint, &target, &resolved_action).await?,
        BrowserActOperation::PressKey => press_key(endpoint, &target, request).await?,
        BrowserActOperation::Scroll => scroll(endpoint, &target, request).await?,
        BrowserActOperation::Wait => wait(request).await?,
    }

    Ok(BrowserActResult {
        ok: true,
        action: request.action.as_str().to_string(),
        message: Some("Browser action completed".to_string()),
    })
}

fn revalidate_resolved_action(
    resolved_action: &BrowserResolvedAction<'_>,
    current_navigation_token: &str,
) -> Result<(), String> {
    if let Some(reference) = resolved_action.reference {
        validate_stale_navigation_token(&reference.navigation_token, current_navigation_token)?;
    }

    if let Some(expected) = resolved_action.page_navigation_token.as_deref() {
        validate_stale_navigation_token(expected, current_navigation_token)?;
    }

    for field in &resolved_action.form_fields {
        validate_stale_navigation_token(&field.navigation_token, current_navigation_token)?;
    }

    Ok(())
}

async fn resolve_page_target(
    endpoint: &BrowserEndpoint,
    tab_id: Option<&str>,
) -> Result<CdpTarget, String> {
    let targets = list_targets(endpoint).await?;
    let mut pages = targets
        .into_iter()
        .filter(|target| target.target_type == "page");
    if let Some(tab_id) = tab_id {
        return pages
            .find(|target| target.id == tab_id)
            .ok_or_else(|| format!("Browser tab '{tab_id}' was not found"));
    }
    pages
        .next()
        .ok_or_else(|| "No browser page target is available".to_string())
}

async fn call_page(
    endpoint: &BrowserEndpoint,
    target: &CdpTarget,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let ws_url = target
        .web_socket_debugger_url
        .as_deref()
        .ok_or_else(|| "Browser page target did not expose a websocket URL".to_string())?;
    validate_loopback_websocket(ws_url, endpoint)?;
    let request = json!({
        "id": 1,
        "method": method,
        "params": params,
    });

    let (mut ws, _) = tokio::time::timeout(
        Duration::from_secs(6),
        connect_async_with_config(
            ws_url,
            Some(websocket_config(MAX_CDP_COMMAND_MESSAGE_BYTES)),
            false,
        ),
    )
    .await
    .map_err(|_| format!("Timed out connecting to browser page websocket for {method}"))?
    .map_err(|error| format!("Failed to connect to browser page websocket: {error}"))?;
    ws.send(Message::Text(request.to_string().into()))
        .await
        .map_err(|error| format!("Failed to send CDP command {method}: {error}"))?;

    loop {
        let message = tokio::time::timeout(Duration::from_secs(8), ws.next())
            .await
            .map_err(|_| format!("Timed out waiting for CDP command {method}"))?
            .ok_or_else(|| format!("Browser websocket closed before {method} completed"))?
            .map_err(|error| format!("Failed to read CDP response for {method}: {error}"))?;

        let Some(text) = cdp_message_text(message, MAX_CDP_COMMAND_MESSAGE_BYTES)? else {
            continue;
        };
        let value: Value = serde_json::from_str(&text)
            .map_err(|error| format!("CDP response for {method} was invalid JSON: {error}"))?;
        if value.get("id").and_then(Value::as_i64) != Some(1) {
            continue;
        }
        if let Some(error) = value.get("error") {
            return Err(format!("CDP command {method} failed: {error}"));
        }
        return Ok(value.get("result").cloned().unwrap_or(Value::Null));
    }
}

fn cdp_message_text(message: Message, max_bytes: usize) -> Result<Option<String>, String> {
    match message {
        Message::Text(text) => {
            if text.len() > max_bytes {
                Err("CDP message exceeded the size limit".to_string())
            } else {
                Ok(Some(text.to_string()))
            }
        }
        Message::Binary(bytes) => {
            if bytes.len() > max_bytes {
                Err("CDP message exceeded the size limit".to_string())
            } else {
                Ok(Some(String::from_utf8_lossy(&bytes).to_string()))
            }
        }
        Message::Close(_) => Err("Browser websocket closed".to_string()),
        _ => Ok(None),
    }
}

fn parse_bounded_json_bytes<T: for<'de> Deserialize<'de>>(
    bytes: &[u8],
    max_bytes: usize,
    label: &str,
) -> Result<T, String> {
    if bytes.len() > max_bytes {
        return Err(format!("{label} exceeded the size limit"));
    }
    serde_json::from_slice(bytes).map_err(|error| error.to_string())
}

fn websocket_config(max_message_bytes: usize) -> WebSocketConfig {
    WebSocketConfig::default()
        .max_message_size(Some(max_message_bytes))
        .max_frame_size(Some(max_message_bytes))
}

async fn connect_page_websocket(
    ws_url: &str,
    max_message_bytes: usize,
) -> Result<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    String,
> {
    let (ws, _) =
        connect_async_with_config(ws_url, Some(websocket_config(max_message_bytes)), false)
            .await
            .map_err(|error| format!("Failed to connect to browser page websocket: {error}"))?;
    Ok(ws)
}

fn diagnostic_message_text(message: Message) -> Option<String> {
    cdp_message_text(message, MAX_CDP_DIAGNOSTIC_MESSAGE_BYTES)
        .ok()
        .flatten()
        .filter(|text| !text.is_empty())
}

#[derive(Debug, Default)]
struct PageDiagnostics {
    console: Vec<String>,
    network: Vec<String>,
    total_bytes: usize,
}

impl PageDiagnostics {
    fn push_console(&mut self, line: String) -> bool {
        push_diagnostic_line(&mut self.console, &mut self.total_bytes, line)
    }

    fn push_network(&mut self, line: String) -> bool {
        push_diagnostic_line(&mut self.network, &mut self.total_bytes, line)
    }
}

async fn collect_page_diagnostics(
    endpoint: &BrowserEndpoint,
    target: &CdpTarget,
    include_console: bool,
    include_network: bool,
) -> Result<PageDiagnostics, String> {
    if !include_console && !include_network {
        return Ok(PageDiagnostics::default());
    }

    let ws_url = target
        .web_socket_debugger_url
        .as_deref()
        .ok_or_else(|| "Browser page target did not expose a websocket URL".to_string())?;
    validate_loopback_websocket(ws_url, endpoint)?;
    let mut ws = tokio::time::timeout(
        Duration::from_secs(6),
        connect_page_websocket(ws_url, MAX_CDP_DIAGNOSTIC_MESSAGE_BYTES),
    )
    .await
    .map_err(|_| "Timed out connecting to browser page websocket for diagnostics".to_string())?
    .map_err(|error| format!("Failed to connect to browser page websocket: {error}"))?;

    let mut next_id = 100_i64;
    if include_console {
        send_cdp_command(&mut ws, next_id, "Runtime.enable", json!({})).await?;
        next_id += 1;
        send_cdp_command(&mut ws, next_id, "Log.enable", json!({})).await?;
        next_id += 1;
    }
    if include_network {
        send_cdp_command(&mut ws, next_id, "Network.enable", json!({})).await?;
    }

    let mut diagnostics = PageDiagnostics::default();
    let mut request_urls = BTreeMap::<String, String>::new();
    let deadline = Instant::now() + Duration::from_millis(700);
    while Instant::now() < deadline
        && diagnostics.total_bytes < MAX_DIAGNOSTIC_TOTAL_BYTES
        && ((include_console && diagnostics.console.len() < MAX_DIAGNOSTIC_ENTRIES)
            || (include_network && diagnostics.network.len() < MAX_DIAGNOSTIC_ENTRIES))
    {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        let Some(message) = tokio::time::timeout(remaining, ws.next())
            .await
            .ok()
            .flatten()
        else {
            break;
        };
        let message =
            message.map_err(|error| format!("Failed to read CDP diagnostics event: {error}"))?;
        if matches!(message, Message::Close(_)) {
            break;
        }
        let Some(text) = diagnostic_message_text(message) else {
            continue;
        };
        let value: Value = serde_json::from_str(&text)
            .map_err(|error| format!("CDP diagnostics event was invalid JSON: {error}"))?;
        let Some(method) = value.get("method").and_then(Value::as_str) else {
            continue;
        };
        let params = value.get("params").cloned().unwrap_or(Value::Null);
        match method {
            "Runtime.consoleAPICalled"
                if include_console && diagnostics.console.len() < MAX_DIAGNOSTIC_ENTRIES =>
            {
                diagnostics.push_console(format_runtime_console_event(&params));
            }
            "Log.entryAdded"
                if include_console && diagnostics.console.len() < MAX_DIAGNOSTIC_ENTRIES =>
            {
                diagnostics.push_console(format_log_entry_event(&params));
            }
            "Network.requestWillBeSent"
                if include_network && request_urls.len() < MAX_TRACKED_REQUEST_URLS =>
            {
                if let (Some(request_id), Some(url)) = (
                    params.get("requestId").and_then(Value::as_str),
                    params
                        .get("request")
                        .and_then(|request| request.get("url"))
                        .and_then(Value::as_str),
                ) {
                    request_urls.insert(
                        truncate_text(request_id, MAX_DIAGNOSTIC_ARG_BYTES),
                        truncate_text(url, MAX_DIAGNOSTIC_ENTRY_BYTES),
                    );
                }
            }
            "Network.responseReceived"
                if include_network && diagnostics.network.len() < MAX_DIAGNOSTIC_ENTRIES =>
            {
                if let Some(line) = format_network_response_event(&params) {
                    diagnostics.push_network(line);
                }
            }
            "Network.loadingFailed"
                if include_network && diagnostics.network.len() < MAX_DIAGNOSTIC_ENTRIES =>
            {
                diagnostics.push_network(format_network_failed_event(&params, &request_urls));
            }
            _ => {}
        }
    }

    Ok(diagnostics)
}

async fn send_cdp_command(
    ws: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    id: i64,
    method: &str,
    params: Value,
) -> Result<(), String> {
    ws.send(Message::Text(
        json!({
            "id": id,
            "method": method,
            "params": params,
        })
        .to_string()
        .into(),
    ))
    .await
    .map_err(|error| format!("Failed to send CDP command {method}: {error}"))
}

fn format_runtime_console_event(params: &Value) -> String {
    let level = params
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("console");
    let text = params
        .get("args")
        .and_then(Value::as_array)
        .map(|args| {
            args.iter()
                .take(MAX_DIAGNOSTIC_ARGS)
                .filter_map(|arg| {
                    arg.get("value")
                        .and_then(Value::as_str)
                        .or_else(|| arg.get("description").and_then(Value::as_str))
                        .map(|value| truncate_text(value, MAX_DIAGNOSTIC_ARG_BYTES))
                })
                .collect::<Vec<_>>()
                .join(" ")
        })
        .filter(|text| !text.trim().is_empty())
        .unwrap_or_else(|| "console event".to_string());
    format!("console.{level}: {text}")
}

fn format_log_entry_event(params: &Value) -> String {
    let entry = params.get("entry").unwrap_or(params);
    let level = entry.get("level").and_then(Value::as_str).unwrap_or("log");
    let text = entry
        .get("text")
        .and_then(Value::as_str)
        .map(|text| truncate_text(text, MAX_DIAGNOSTIC_ENTRY_BYTES))
        .unwrap_or_else(|| "log entry".to_string());
    format!("log.{level}: {text}")
}

fn format_network_response_event(params: &Value) -> Option<String> {
    let response = params.get("response")?;
    let status = response.get("status").and_then(Value::as_u64)?;
    if status < 400 {
        return None;
    }
    let url = response
        .get("url")
        .and_then(Value::as_str)
        .map(|url| truncate_text(url, MAX_DIAGNOSTIC_ENTRY_BYTES))
        .unwrap_or_else(|| "unknown URL".to_string());
    let status_text = response
        .get("statusText")
        .and_then(Value::as_str)
        .map(|text| truncate_text(text, MAX_DIAGNOSTIC_ARG_BYTES))
        .unwrap_or_default();
    Some(format!("response {status} {status_text}: {url}"))
}

fn format_network_failed_event(params: &Value, request_urls: &BTreeMap<String, String>) -> String {
    let request_id = params
        .get("requestId")
        .and_then(Value::as_str)
        .map(|id| truncate_text(id, MAX_DIAGNOSTIC_ARG_BYTES))
        .unwrap_or_default();
    let url = request_urls
        .get(&request_id)
        .map(String::as_str)
        .unwrap_or("unknown URL");
    let error_text = params
        .get("errorText")
        .and_then(Value::as_str)
        .map(|text| truncate_text(text, MAX_DIAGNOSTIC_ARG_BYTES))
        .unwrap_or_else(|| "network request failed".to_string());
    format!("failed {error_text}: {url}")
}

fn push_diagnostic_line(lines: &mut Vec<String>, total_bytes: &mut usize, line: String) -> bool {
    if *total_bytes >= MAX_DIAGNOSTIC_TOTAL_BYTES {
        return false;
    }

    let per_entry = truncate_text(&line, MAX_DIAGNOSTIC_ENTRY_BYTES);
    let remaining = MAX_DIAGNOSTIC_TOTAL_BYTES.saturating_sub(*total_bytes);
    let bounded = truncate_text(&per_entry, remaining);
    *total_bytes = (*total_bytes).saturating_add(bounded.len());
    lines.push(bounded);
    true
}

fn truncate_text(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }

    let suffix = if max_bytes >= TRUNCATED_SUFFIX.len() {
        TRUNCATED_SUFFIX
    } else {
        ""
    };
    let prefix_limit = max_bytes.saturating_sub(suffix.len());
    let mut end = 0;
    for (index, character) in value.char_indices() {
        let next = index + character.len_utf8();
        if next > prefix_limit {
            break;
        }
        end = next;
    }

    format!("{}{}", &value[..end], suffix)
}

fn parse_dom_refs(value: Value, navigation_token: &str) -> Result<Vec<BrowserDomRef>, String> {
    let items = value
        .get("result")
        .and_then(|result| result.get("value"))
        .and_then(Value::as_array)
        .ok_or_else(|| "Browser DOM snapshot did not return an array".to_string())?;

    Ok(items
        .iter()
        .enumerate()
        .filter_map(|(index, item)| {
            let description = item
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("element")
                .to_string();
            let selector = item.get("selector")?.as_str()?.to_string();
            Some(BrowserDomRef {
                ref_id: format!("ref-{index}"),
                navigation_token: navigation_token.to_string(),
                description,
                editable: item
                    .get("editable")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                selector,
                x: item.get("x").and_then(Value::as_f64).unwrap_or(0.0),
                y: item.get("y").and_then(Value::as_f64).unwrap_or(0.0),
            })
        })
        .collect())
}

async fn click(
    endpoint: &BrowserEndpoint,
    target: &CdpTarget,
    reference: Option<&BrowserDomRef>,
) -> Result<(), String> {
    let reference = reference
        .ok_or_else(|| "Browser click requires an observed ref and navigationToken".to_string())?;
    let selector = css_string(&reference.selector);
    call_page(
        endpoint,
        target,
        "Runtime.evaluate",
        json!({
            "expression": format!("(() => {{ const el = document.querySelector({selector}); if (!el) throw new Error('target not found'); el.scrollIntoView({{ block: 'center', inline: 'center' }}); if (typeof el.focus === 'function') el.focus({{ preventScroll: true }}); el.click(); return true; }})()"),
            "awaitPromise": true,
            "returnByValue": true
        }),
    )
    .await?;
    Ok(())
}

async fn type_text(
    endpoint: &BrowserEndpoint,
    target: &CdpTarget,
    request: &super::types::BrowserActRequest,
    reference: Option<&BrowserDomRef>,
    replace: bool,
) -> Result<(), String> {
    let reference =
        reference.ok_or_else(|| "Browser type/fill requires an observed ref".to_string())?;
    let focused = focus_and_verify_editable(endpoint, target, reference).await?;
    if focused.tag == "SELECT" {
        let text = if replace {
            request
                .value
                .as_deref()
                .ok_or_else(|| "fill requires value".to_string())?
        } else {
            request
                .text
                .as_deref()
                .ok_or_else(|| "type requires text".to_string())?
        };
        set_select_value(endpoint, target, reference, text).await?;
        return Ok(());
    }
    if replace {
        call_page(
            endpoint,
            target,
            "Input.dispatchKeyEvent",
            json!({ "type": "keyDown", "modifiers": SELECT_ALL_MODIFIER, "windowsVirtualKeyCode": 65, "code": "KeyA", "key": "a" }),
        )
        .await?;
        call_page(
            endpoint,
            target,
            "Input.dispatchKeyEvent",
            json!({ "type": "keyUp", "modifiers": SELECT_ALL_MODIFIER, "windowsVirtualKeyCode": 65, "code": "KeyA", "key": "a" }),
        )
        .await?;
    }
    let text = if replace {
        request
            .value
            .as_deref()
            .ok_or_else(|| "fill requires value".to_string())?
    } else {
        request
            .text
            .as_deref()
            .ok_or_else(|| "type requires text".to_string())?
    };
    call_page(
        endpoint,
        target,
        "Input.insertText",
        json!({ "text": text }),
    )
    .await?;
    Ok(())
}

async fn set_select_value(
    endpoint: &BrowserEndpoint,
    target: &CdpTarget,
    reference: &BrowserDomRef,
    text: &str,
) -> Result<(), String> {
    let selector = css_string(&reference.selector);
    let value = css_string(text);
    call_page(
        endpoint,
        target,
        "Runtime.evaluate",
        json!({
            "expression": format!(
                "(() => {{ const el = document.querySelector({selector}); if (!el || el.tagName !== 'SELECT') throw new Error('select target not found'); const options = Array.from(el.options || []); const match = options.find((option) => option.value === {value}) || options.find((option) => option.textContent.trim() === {value}); if (!match) throw new Error('select option not found'); el.value = match.value; el.dispatchEvent(new Event('input', {{ bubbles: true }})); el.dispatchEvent(new Event('change', {{ bubbles: true }})); return true; }})()"
            ),
            "awaitPromise": true,
            "returnByValue": true
        }),
    )
    .await?;
    Ok(())
}

async fn fill_form(
    endpoint: &BrowserEndpoint,
    target: &CdpTarget,
    resolved_action: &BrowserResolvedAction<'_>,
) -> Result<(), String> {
    if resolved_action.form_fields.is_empty() {
        return Err("fill_form requires fields".to_string());
    }
    for field in &resolved_action.form_fields {
        let selector = css_string(&field.selector);
        let value = css_string(&field.value);
        call_page(
            endpoint,
            target,
            "Runtime.evaluate",
            json!({
                "expression": format!(
                    "(() => {{ const el = document.querySelector({selector}); if (!el) throw new Error('field not found'); el.focus(); el.value = {value}; el.dispatchEvent(new Event('input', {{ bubbles: true }})); el.dispatchEvent(new Event('change', {{ bubbles: true }})); return true; }})()"
                ),
                "awaitPromise": true,
                "returnByValue": true
            }),
        )
        .await?;
    }
    Ok(())
}

async fn press_key(
    endpoint: &BrowserEndpoint,
    target: &CdpTarget,
    request: &super::types::BrowserActRequest,
) -> Result<(), String> {
    let key = request
        .key
        .as_deref()
        .ok_or_else(|| "press_key requires key".to_string())?;
    call_page(
        endpoint,
        target,
        "Input.dispatchKeyEvent",
        json!({ "type": "keyDown", "key": key }),
    )
    .await?;
    call_page(
        endpoint,
        target,
        "Input.dispatchKeyEvent",
        json!({ "type": "keyUp", "key": key }),
    )
    .await?;
    Ok(())
}

async fn scroll(
    endpoint: &BrowserEndpoint,
    target: &CdpTarget,
    request: &super::types::BrowserActRequest,
) -> Result<(), String> {
    let x = request.delta_x.unwrap_or(0);
    let y = request.delta_y.unwrap_or(600);
    call_page(
        endpoint,
        target,
        "Runtime.evaluate",
        json!({
            "expression": format!("window.scrollBy({}, {}); true", x, y),
            "returnByValue": true
        }),
    )
    .await?;
    Ok(())
}

async fn wait(request: &super::types::BrowserActRequest) -> Result<(), String> {
    let timeout_ms = request.timeout_ms.unwrap_or(1000).clamp(100, 120_000);
    tokio::time::sleep(Duration::from_millis(timeout_ms)).await;
    Ok(())
}

async fn focus_and_verify_editable(
    endpoint: &BrowserEndpoint,
    target: &CdpTarget,
    reference: &BrowserDomRef,
) -> Result<FocusedEditableElement, String> {
    let selector = css_string(&reference.selector);
    let result = call_page(
        endpoint,
        target,
        "Runtime.evaluate",
        json!({
            "expression": format!(
                "(() => {{ const el = document.querySelector({selector}); if (!el) return {{ ok: false, reason: 'not_found' }}; el.focus(); const active = document.activeElement === el; const editable = !el.disabled && !el.readOnly && (el.isContentEditable || ['INPUT','TEXTAREA','SELECT'].includes(el.tagName)); return {{ ok: active && editable, active, editable, tag: el.tagName, type: el.type || '' }}; }})()"
            ),
            "awaitPromise": true,
            "returnByValue": true
        }),
    )
    .await?;
    let value = result
        .get("result")
        .and_then(|result| result.get("value"))
        .cloned()
        .unwrap_or(Value::Null);
    if value.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(FocusedEditableElement {
            tag: value
                .get("tag")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        })
    } else {
        Err("Browser target is not active and editable".to_string())
    }
}

fn write_screenshot_artifact(base64_png: &str) -> Result<PathBuf, String> {
    write_screenshot_artifact_in(base64_png, &screenshot_artifact_directory())
}

fn write_screenshot_artifact_in(base64_png: &str, directory: &Path) -> Result<PathBuf, String> {
    if base64_png.len() > MAX_SCREENSHOT_ARTIFACT_BASE64_BYTES {
        return Err("Browser screenshot artifact is too large".to_string());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_png)
        .map_err(|error| format!("Browser screenshot was not valid base64: {error}"))?;
    if bytes.len() > MAX_SCREENSHOT_ARTIFACT_BYTES {
        return Err("Browser screenshot artifact is too large".to_string());
    }
    let _ = prune_screenshot_artifacts_in(directory, SystemTime::now());
    fs::create_dir_all(directory).map_err(|error| {
        format!("Failed to create browser screenshot artifact directory: {error}")
    })?;
    harden_artifact_directory(directory)?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let path = directory.join(format!(
        "browser-screenshot-{}-{nonce}.png",
        std::process::id()
    ));
    fs::write(&path, bytes)
        .map_err(|error| format!("Failed to write browser screenshot artifact: {error}"))?;
    harden_artifact_file(&path)?;
    let _ = prune_screenshot_artifacts_in(directory, SystemTime::now());
    Ok(path)
}

pub fn prune_screenshot_artifacts() -> Result<(), String> {
    prune_screenshot_artifacts_in(&screenshot_artifact_directory(), SystemTime::now())
}

fn screenshot_artifact_directory() -> PathBuf {
    static ARTIFACT_DIR: OnceLock<PathBuf> = OnceLock::new();
    ARTIFACT_DIR
        .get_or_init(|| {
            tempfile::Builder::new()
                .prefix("touchai-browser-artifacts-")
                .tempdir()
                .map(|dir| dir.keep())
                .unwrap_or_else(|_| {
                    std::env::temp_dir().join(format!(
                        "touchai-browser-artifacts-{}-{}",
                        std::process::id(),
                        SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .map(|duration| duration.as_nanos())
                            .unwrap_or_default()
                    ))
                })
        })
        .clone()
}

#[cfg(unix)]
fn harden_artifact_directory(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|error| {
        format!("Failed to restrict browser screenshot artifact directory permissions: {error}")
    })
}

#[cfg(not(unix))]
fn harden_artifact_directory(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
fn harden_artifact_file(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|error| {
        format!("Failed to restrict browser screenshot artifact permissions: {error}")
    })
}

#[cfg(not(unix))]
fn harden_artifact_file(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn prune_screenshot_artifacts_in(directory: &Path, now: SystemTime) -> Result<(), String> {
    if !directory.exists() {
        return Ok(());
    }

    let mut retained = Vec::new();
    let entries = fs::read_dir(directory).map_err(|error| {
        format!("Failed to read browser screenshot artifact directory: {error}")
    })?;
    for entry in entries.flatten() {
        let file_name = entry.file_name();
        let file_name = file_name.to_string_lossy();
        if !file_name.starts_with(SCREENSHOT_ARTIFACT_PREFIX) || !file_name.ends_with(".png") {
            continue;
        }

        let path = entry.path();
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let modified = metadata.modified().unwrap_or(UNIX_EPOCH);
        let expired = now
            .duration_since(modified)
            .map(|age| age > SCREENSHOT_ARTIFACT_TTL)
            .unwrap_or(false);
        if expired {
            let _ = fs::remove_file(path);
        } else {
            retained.push((modified, path));
        }
    }

    if retained.len() > MAX_SCREENSHOT_ARTIFACTS {
        retained.sort_by_key(|(modified, _)| *modified);
        let excess = retained.len() - MAX_SCREENSHOT_ARTIFACTS;
        for (_, path) in retained.into_iter().take(excess) {
            let _ = fs::remove_file(path);
        }
    }

    Ok(())
}

fn css_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

const DOM_REF_SCRIPT: &str = r#"
(() => {
  const cssEscape = globalThis.CSS && CSS.escape ? CSS.escape.bind(CSS) : (value) => String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  const selectorFor = (el) => {
    if (el.id) return `#${cssEscape(el.id)}`;
    const parts = [];
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE && parts.length < 5) {
      let part = node.localName;
      if (!part) break;
      const testId = node.getAttribute('data-testid');
      if (testId) {
        part += `[data-testid="${String(testId).replace(/"/g, '\\"')}"]`;
        parts.unshift(part);
        break;
      }
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((child) => child.localName === node.localName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  };
  const labelFor = (el) => {
    const clean = (value) => String(value || '').trim().replace(/\s+/g, ' ').slice(0, 120);
    const aria = clean(el.getAttribute('aria-label'));
    const labelledBy = el.getAttribute('aria-labelledby');
    const labelledText = clean(labelledBy ? labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' ') : '');
    const tag = el.tagName.toLowerCase();
    const state = clean(['input','textarea','select'].includes(tag) ? el.value : (el.innerText || el.textContent || ''));
    const base = aria || labelledText || clean(el.placeholder) || clean(el.title) || clean(el.name) || clean(el.id) || clean(el.tagName);
    return state && state !== base ? `${base}: ${state}` : base;
  };
  return Array.from(document.querySelectorAll('a[href],button,input,textarea,select,[role="button"],[contenteditable="true"],[tabindex]'))
    .filter((el) => {
      const style = getComputedStyle(el);
      return style.visibility !== 'hidden' && style.display !== 'none';
    })
    .slice(0, 100)
    .map((el) => {
      const rect = el.getBoundingClientRect();
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute('role') || '';
      const editable = !el.disabled && !el.readOnly && (el.isContentEditable || ['input','textarea','select'].includes(tag));
      return {
        selector: selectorFor(el),
        description: `${tag}${role ? ` role=${role}` : ''}: ${labelFor(el)}`,
        editable,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2
      };
    });
})()
"#;

#[cfg(test)]
mod tests {
    use std::{fs, time::Duration};

    use base64::Engine;
    use serde_json::json;
    use tempfile::TempDir;

    use super::*;

    #[test]
    fn diagnostic_lines_are_byte_bounded() {
        let long_text = "a".repeat(MAX_DIAGNOSTIC_ENTRY_BYTES * 2);
        let console = format_runtime_console_event(&json!({
            "type": "error",
            "args": [{ "value": long_text }]
        }));
        let mut diagnostics = PageDiagnostics::default();

        assert!(diagnostics.push_console(console));

        assert_eq!(diagnostics.console.len(), 1);
        assert!(diagnostics.console[0].len() <= MAX_DIAGNOSTIC_ENTRY_BYTES);
        assert!(diagnostics.console[0].contains("[truncated]"));
    }

    #[test]
    fn oversized_diagnostic_messages_are_dropped_before_json_parse() {
        let oversized = "a".repeat(MAX_CDP_DIAGNOSTIC_MESSAGE_BYTES + 1);

        assert_eq!(
            diagnostic_message_text(Message::Text(oversized.into())),
            None
        );
    }

    #[test]
    fn bounded_json_bytes_reject_oversized_http_bodies() {
        let oversized = vec![b' '; MAX_CDP_HTTP_BODY_BYTES + 1];

        let error = parse_bounded_json_bytes::<Vec<CdpTarget>>(
            &oversized,
            MAX_CDP_HTTP_BODY_BYTES,
            "browser tab listing",
        )
        .expect_err("oversized body");

        assert_eq!(error, "browser tab listing exceeded the size limit");
    }

    #[test]
    fn command_messages_are_byte_bounded_before_json_parse() {
        let oversized = "a".repeat(MAX_CDP_COMMAND_MESSAGE_BYTES + 1);

        assert_eq!(
            cdp_message_text(
                Message::Text(oversized.into()),
                MAX_CDP_COMMAND_MESSAGE_BYTES
            )
            .expect_err("oversized command message"),
            "CDP message exceeded the size limit"
        );
    }

    #[test]
    fn command_control_frames_are_skipped() {
        assert_eq!(
            cdp_message_text(
                Message::Ping(Vec::new().into()),
                MAX_CDP_COMMAND_MESSAGE_BYTES
            )
            .expect("control frame should not error"),
            None
        );
    }

    #[test]
    fn fingerprint_compat_script_covers_common_automation_surfaces() {
        let script = browser_fingerprint_compat_script(Some("en-US"));

        assert!(script.contains("'webdriver'"));
        assert!(script.contains("'plugins'"));
        assert!(script.contains("'mimeTypes'"));
        assert!(script.contains("chrome.runtime"));
        assert!(script.contains("permissions.query"));
        assert!(script.contains("WebGLRenderingContext"));
        assert!(script.contains("HTMLCanvasElement"));
        assert!(script.contains("\"en-US\""));
    }

    #[test]
    fn diagnostic_total_bytes_are_bounded() {
        let mut diagnostics = PageDiagnostics::default();

        for index in 0..100 {
            diagnostics.push_network(format!("{index}: {}", "b".repeat(2048)));
        }

        assert!(diagnostics.total_bytes <= MAX_DIAGNOSTIC_TOTAL_BYTES);
        assert!(diagnostics.network.len() < 100);
    }

    #[test]
    fn screenshot_artifact_writer_prunes_to_retention_cap() {
        let temp = TempDir::new().expect("temp dir");
        let artifact_dir = temp.path().join("touchai-browser-artifacts");
        fs::create_dir_all(&artifact_dir).expect("artifact dir");
        for index in 0..(MAX_SCREENSHOT_ARTIFACTS + 5) {
            fs::write(
                artifact_dir.join(format!(
                    "{SCREENSHOT_ARTIFACT_PREFIX}{}-{index}.png",
                    std::process::id()
                )),
                [index as u8],
            )
            .expect("write artifact");
        }

        prune_screenshot_artifacts_in(&artifact_dir, SystemTime::now()).expect("prune artifacts");

        let retained = fs::read_dir(&artifact_dir)
            .expect("read artifact dir")
            .flatten()
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(SCREENSHOT_ARTIFACT_PREFIX)
            })
            .count();
        assert_eq!(retained, MAX_SCREENSHOT_ARTIFACTS);
    }

    #[test]
    fn screenshot_artifact_prune_removes_expired_generated_files_and_preserves_unrelated() {
        let temp = TempDir::new().expect("temp dir");
        let artifact_dir = temp.path().join("touchai-browser-artifacts");
        fs::create_dir_all(&artifact_dir).expect("artifact dir");
        let old_path = artifact_dir.join(format!("{SCREENSHOT_ARTIFACT_PREFIX}old.png"));
        let fresh_path = artifact_dir.join(format!("{SCREENSHOT_ARTIFACT_PREFIX}fresh.png"));
        let unrelated_path = artifact_dir.join("unrelated.png");
        fs::write(&old_path, [1]).expect("write old");
        fs::write(&fresh_path, [2]).expect("write fresh");
        fs::write(&unrelated_path, [3]).expect("write unrelated");

        let now = SystemTime::now() + SCREENSHOT_ARTIFACT_TTL + Duration::from_secs(1);
        prune_screenshot_artifacts_in(&artifact_dir, now).expect("prune artifacts");

        assert!(!old_path.exists());
        assert!(!fresh_path.exists());
        assert!(unrelated_path.exists());
    }

    #[test]
    fn screenshot_artifact_writer_decodes_base64_to_png_file() {
        let temp = TempDir::new().expect("temp dir");
        let artifact_dir = temp.path().join("touchai-browser-artifacts");

        let payload = base64::engine::general_purpose::STANDARD.encode([137, 80, 78, 71]);
        let path = write_screenshot_artifact_in(&payload, &artifact_dir).expect("write artifact");

        assert_eq!(
            fs::read(path).expect("read artifact"),
            vec![137, 80, 78, 71]
        );
    }

    #[test]
    fn screenshot_artifact_directory_is_randomized_per_runtime() {
        let first = screenshot_artifact_directory();
        let second = screenshot_artifact_directory();

        assert_eq!(first, second);
        assert!(first
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("touchai-browser-artifacts-")));
        assert_ne!(
            first,
            std::env::temp_dir().join("touchai-browser-artifacts")
        );
    }

    #[test]
    fn screenshot_artifact_writer_rejects_oversized_payloads() {
        let temp = TempDir::new().expect("temp dir");
        let artifact_dir = temp.path().join("touchai-browser-artifacts");
        let payload = "a".repeat(MAX_SCREENSHOT_ARTIFACT_BASE64_BYTES + 1);

        let error =
            write_screenshot_artifact_in(&payload, &artifact_dir).expect_err("oversized payload");

        assert_eq!(error, "Browser screenshot artifact is too large");
        assert!(!artifact_dir.exists());
    }
}
