// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! MCP 进程管理命令。

use std::time::{Instant, SystemTime, UNIX_EPOCH};

use crate::core::analytics::{AnalyticsOperationHandle, AnalyticsRuntime, AnalyticsTrackRequest};
use crate::core::mcp::{
    McpClientManager, McpServerConfig, McpToolCallResponse, McpToolDefinition, ServerStatusInfo,
};
use crate::core::observability::trace::with_traceparent;
use serde_json::{Map as JsonMap, Number as JsonNumber, Value as JsonValue};
use tauri::{Manager, State};

const MAX_ANALYTICS_DURATION_MS: u64 = 86_400_000;

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

/// Maps a connection error onto the fixed public category. The raw error can
/// contain a server name, URL, header or command, so it never leaves native and
/// is never put into analytics attributes or a new log line.
fn mcp_connection_error_category(error: &str) -> &'static str {
    let normalized = error.to_ascii_lowercase();
    if normalized.contains("401")
        || normalized.contains("403")
        || normalized.contains("unauthorized")
        || normalized.contains("forbidden")
        || normalized.contains("auth")
        || normalized.contains("token")
        || normalized.contains("credential")
    {
        return "auth";
    }
    if normalized.contains("timed out")
        || normalized.contains("timeout")
        || normalized.contains("network")
        || normalized.contains("connection refused")
        || normalized.contains("failed to create transport")
        || normalized.contains("dns")
        || normalized.contains("error sending request")
    {
        return "network";
    }
    if normalized.contains("protocol")
        || normalized.contains("handshake")
        || normalized.contains("initialize")
        || normalized.contains("json")
        || normalized.contains("rpc")
        || normalized.contains("unexpected")
        || normalized.contains("invalid")
    {
        return "protocol";
    }
    "other"
}

fn bounded_duration_ms(started: Instant) -> u64 {
    started
        .elapsed()
        .as_millis()
        .min(MAX_ANALYTICS_DURATION_MS as u128) as u64
}

/// Maps the WebView-declared origin onto the public connection kind. Startup
/// auto-connect is a passive background reconciliation, not a user action, so it
/// must never start or refresh a user analytics session.
fn normalize_mcp_connection_kind(origin: Option<&str>) -> &'static str {
    match origin {
        Some("background") | Some("background_reconnect") => "background_reconnect",
        _ => "user",
    }
}

fn mcp_connection_attributes(
    connection_id: &str,
    connection_kind: &str,
    result: &str,
    duration_ms: u64,
    error_category: Option<&str>,
) -> JsonMap<String, JsonValue> {
    let mut attributes = JsonMap::new();
    attributes.insert(
        "connection_id".to_string(),
        JsonValue::String(connection_id.to_string()),
    );
    attributes.insert(
        "connection_kind".to_string(),
        JsonValue::String(connection_kind.to_string()),
    );
    attributes.insert("result".to_string(), JsonValue::String(result.to_string()));
    attributes.insert(
        "duration_ms".to_string(),
        JsonValue::Number(JsonNumber::from(duration_ms.min(MAX_ANALYTICS_DURATION_MS))),
    );
    if let Some(category) = error_category {
        attributes.insert(
            "error_category".to_string(),
            JsonValue::String(category.to_string()),
        );
    }
    attributes
}

/// Emits `mcp.connection_completed` off the connection command's critical path
/// and always releases the native operation handle, including when tracking is
/// disabled or unavailable. Any analytics failure is ignored.
fn report_mcp_connection_completed(
    analytics: AnalyticsRuntime,
    operation: AnalyticsOperationHandle,
    result: Result<(), String>,
    started: Instant,
    connection_kind: &str,
) {
    let (result_label, error_category) = match &result {
        Ok(()) => ("success", None),
        Err(error) => ("failure", Some(mcp_connection_error_category(error))),
    };
    let attributes = mcp_connection_attributes(
        &uuid::Uuid::new_v4().to_string(),
        connection_kind,
        result_label,
        bounded_duration_ms(started),
        error_category,
    );
    let operation_id = operation.operation_id;
    tauri::async_runtime::spawn(async move {
        let request = AnalyticsTrackRequest {
            event_name: "mcp.connection_completed".to_string(),
            occurred_at_ms: now_millis(),
            operation_id: Some(operation_id.clone()),
            attributes,
        };
        let _ = analytics.track(request).await;
        analytics.complete_operation(&operation_id).await;
    });
}

// ===== MCP 客户端命令 =====

#[tauri::command]
pub async fn mcp_connect_server<R: tauri::Runtime>(
    client_manager: State<'_, McpClientManager>,
    app: tauri::AppHandle<R>,
    config: McpServerConfig,
    connection_origin: Option<String>,
    traceparent: Option<String>,
) -> Result<(), String> {
    let started = Instant::now();
    let connection_kind = normalize_mcp_connection_kind(connection_origin.as_deref());
    // Analytics is optional infrastructure: a missing runtime must never stop a
    // user from connecting an MCP server.
    let analytics = app
        .try_state::<AnalyticsRuntime>()
        .map(|runtime| runtime.inner().clone());
    let operation = match &analytics {
        Some(runtime) => Some(runtime.begin_operation().await),
        None => None,
    };
    let result = with_traceparent(
        traceparent,
        "mcp.connect",
        client_manager.connect_server(config),
    )
    .await;
    if let (Some(runtime), Some(operation)) = (analytics, operation) {
        report_mcp_connection_completed(
            runtime,
            operation,
            result.clone(),
            started,
            connection_kind,
        );
    }
    result
}

#[tauri::command]
pub async fn mcp_disconnect_server(
    client_manager: State<'_, McpClientManager>,
    server_id: i64,
    traceparent: Option<String>,
) -> Result<(), String> {
    with_traceparent(
        traceparent,
        "mcp.disconnect",
        client_manager.disconnect_server(server_id),
    )
    .await
}

#[tauri::command]
pub async fn mcp_list_tools(
    client_manager: State<'_, McpClientManager>,
    server_id: i64,
    traceparent: Option<String>,
) -> Result<Vec<McpToolDefinition>, String> {
    with_traceparent(
        traceparent,
        "mcp.list_tools",
        client_manager.list_tools(server_id),
    )
    .await
}

#[tauri::command]
pub async fn mcp_call_tool(
    client_manager: State<'_, McpClientManager>,
    server_id: i64,
    tool_name: String,
    arguments: serde_json::Value,
    timeout_ms: Option<u64>,
    traceparent: Option<String>,
) -> Result<McpToolCallResponse, String> {
    with_traceparent(
        traceparent,
        "mcp.call_tool",
        client_manager.call_tool(server_id, tool_name, arguments, timeout_ms),
    )
    .await
}

#[tauri::command]
pub async fn mcp_get_client_status(
    client_manager: State<'_, McpClientManager>,
    server_id: i64,
) -> Result<ServerStatusInfo, String> {
    client_manager.get_server_status(server_id).await
}

/// 获取全部 MCP 客户端状态。
#[tauri::command]
pub async fn mcp_get_all_client_statuses(
    client_manager: State<'_, McpClientManager>,
) -> Result<Vec<ServerStatusInfo>, String> {
    // 统一走 Result 语义，保持命令层错误处理一致。
    client_manager.get_all_server_statuses_result().await
}

#[tauri::command]
pub async fn mcp_disconnect_all(client_manager: State<'_, McpClientManager>) -> Result<(), String> {
    client_manager.disconnect_all().await
}

#[cfg(test)]
mod tests {
    use super::{
        mcp_connection_attributes, mcp_connection_error_category, normalize_mcp_connection_kind,
    };

    #[test]
    fn user_gets_a_bounded_category_for_mcp_connection_failures() {
        assert_eq!(
            mcp_connection_error_category("401 Unauthorized for token sk-secret"),
            "auth"
        );
        assert_eq!(
            mcp_connection_error_category("Failed to create transport: connection refused"),
            "network"
        );
        assert_eq!(
            mcp_connection_error_category("MCP initialize handshake failed"),
            "protocol"
        );
        assert_eq!(
            mcp_connection_error_category("server my-private-server exited"),
            "other"
        );
    }

    #[test]
    fn user_gets_startup_auto_connect_classified_as_background_not_user() {
        assert_eq!(
            normalize_mcp_connection_kind(Some("background")),
            "background_reconnect"
        );
        assert_eq!(
            normalize_mcp_connection_kind(Some("background_reconnect")),
            "background_reconnect"
        );
        assert_eq!(normalize_mcp_connection_kind(Some("user")), "user");
        assert_eq!(normalize_mcp_connection_kind(None), "user");
        assert_eq!(normalize_mcp_connection_kind(Some("unexpected")), "user");
    }

    #[test]
    fn user_gets_ambiguous_mcp_errors_classified_by_documented_precedence() {
        assert_eq!(
            mcp_connection_error_category("authentication timeout while connecting"),
            "auth"
        );
        assert_eq!(
            mcp_connection_error_category("protocol handshake timed out"),
            "network"
        );
        assert_eq!(
            mcp_connection_error_category("invalid credentials in protocol header"),
            "auth"
        );
    }

    #[test]
    fn user_gets_bounded_mcp_attributes_without_raw_error_or_server_data() {
        let secret = "token=sk-secret server=https://private.example command=secret-bin";
        let category = mcp_connection_error_category(secret);
        let attributes = mcp_connection_attributes(
            "11111111-1111-4111-8111-111111111111",
            "user",
            "failure",
            42,
            Some(category),
        );
        let rendered = serde_json::to_string(&attributes).expect("serialize attributes");

        assert_eq!(
            attributes.get("connection_kind").and_then(|v| v.as_str()),
            Some("user")
        );
        assert_eq!(
            attributes.get("result").and_then(|v| v.as_str()),
            Some("failure")
        );
        assert_eq!(
            attributes.get("duration_ms").and_then(|v| v.as_u64()),
            Some(42)
        );
        assert_eq!(
            attributes.get("error_category").and_then(|v| v.as_str()),
            Some("auth")
        );
        assert!(!rendered.contains("sk-secret"));
        assert!(!rendered.contains("private.example"));
        assert!(!rendered.contains("secret-bin"));
    }
}
