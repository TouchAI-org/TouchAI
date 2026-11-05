mod common;

use common::{build_test_app, invoke_command_err, invoke_command_ok, TestAppOptions};
use serde_json::json;
use sqlx::{sqlite::SqliteConnectOptions, Connection};
use tauri::{WebviewUrl, WebviewWindowBuilder};

fn database_operation(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    request: serde_json::Value,
) -> serde_json::Value {
    invoke_command_ok(webview, "database_operation", json!({ "request": request }))
}

fn execute_sql(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    sql: &str,
    params: serde_json::Value,
) {
    let response: serde_json::Value = invoke_command_ok(
        webview,
        "database_query",
        json!({ "request": { "sql": sql, "params": params, "method": "run" } }),
    );
    assert!(response["rowsAffected"].as_u64().is_some());
}

fn query_sql(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    sql: &str,
    params: serde_json::Value,
) -> serde_json::Value {
    invoke_command_ok(
        webview,
        "database_query",
        json!({ "request": { "sql": sql, "params": params, "method": "all" } }),
    )
}

#[test]
fn database_query_returns_rows_from_sqlite_runtime() {
    let test_app = build_test_app(TestAppOptions::with_database_runtime()).expect("test app");

    let response: serde_json::Value = invoke_command_ok(
        &test_app.main_webview,
        "database_query",
        json!({
            "request": {
                "sql": "SELECT 1 AS value",
                "method": "get"
            }
        }),
    );

    assert_eq!(
        response,
        json!({
            "rows": [
                { "value": 1 }
            ],
            "rowsAffected": 0,
            "lastInsertId": null
        })
    );
}

#[test]
fn user_can_read_and_write_settings_through_the_typed_database_operation() {
    let test_app = build_test_app(TestAppOptions::with_database_runtime()).expect("test app");

    let written: serde_json::Value = invoke_command_ok(
        &test_app.main_webview,
        "database_operation",
        json!({
            "request": {
                "kind": "setting_set",
                "key": "language",
                "value": "zh-CN"
            }
        }),
    );
    assert_eq!(written["key"], "language");
    assert_eq!(written["value"], "zh-CN");

    let value: String = invoke_command_ok(
        &test_app.main_webview,
        "database_operation",
        json!({
            "request": {
                "kind": "setting_get",
                "key": "language"
            }
        }),
    );
    assert_eq!(value, "zh-CN");

    let values: serde_json::Value = invoke_command_ok(
        &test_app.main_webview,
        "database_operation",
        json!({
            "request": {
                "kind": "setting_get_many",
                "keys": ["language", "missing"]
            }
        }),
    );
    assert_eq!(values, json!({ "language": "zh-CN", "missing": null }));
}

#[test]
fn user_gets_exactly_one_default_model_through_the_typed_database_operation() {
    let test_app = build_test_app(TestAppOptions::with_database_runtime()).expect("test app");
    execute_sql(
        &test_app.main_webview,
        "INSERT INTO providers (id, name, driver, api_endpoint, logo, enabled)
         VALUES (7001, 'OpenAI', 'openai', 'https://openai.example/v1', 'openai.png', 1)",
        json!([]),
    );
    execute_sql(
        &test_app.main_webview,
        "INSERT INTO models (id, provider_id, name, model_id, is_default)
         VALUES (1001, 7001, 'Old', 'old-model', 1), (1002, 7001, 'New', 'new-model', 0)",
        json!([]),
    );

    let response = database_operation(
        &test_app.main_webview,
        json!({ "kind": "model_set_default", "modelId": 1002 }),
    );
    assert_eq!(response, serde_json::Value::Null);

    let defaults = query_sql(
        &test_app.main_webview,
        "SELECT id FROM models WHERE is_default = 1 ORDER BY id",
        json!([]),
    );
    assert_eq!(defaults["rows"], json!([{ "id": 1002 }]));
}

#[test]
fn user_keeps_the_previous_default_when_the_typed_target_provider_is_disabled() {
    let test_app = build_test_app(TestAppOptions::with_database_runtime()).expect("test app");
    execute_sql(
        &test_app.main_webview,
        "INSERT INTO providers (id, name, driver, api_endpoint, logo, enabled)
         VALUES (7001, 'Enabled', 'openai', 'https://enabled.example/v1', 'openai.png', 1),
                (8001, 'Disabled', 'openai', 'https://disabled.example/v1', 'openai.png', 0)",
        json!([]),
    );
    execute_sql(
        &test_app.main_webview,
        "INSERT INTO models (id, provider_id, name, model_id, is_default)
         VALUES (1001, 7001, 'Current', 'current-model', 1),
                (1002, 8001, 'Disabled', 'disabled-model', 0)",
        json!([]),
    );

    let error = invoke_command_err(
        &test_app.main_webview,
        "database_operation",
        json!({
            "request": {
                "kind": "model_set_default",
                "modelId": 1002
            }
        }),
    );
    assert_eq!(error["code"], "provider-disabled");
    assert_eq!(error["message"], "Disabled");

    let defaults = query_sql(
        &test_app.main_webview,
        "SELECT id FROM models WHERE is_default = 1 ORDER BY id",
        json!([]),
    );
    assert_eq!(defaults["rows"], json!([{ "id": 1001 }]));
}

#[test]
fn user_gets_mcp_tool_enabled_preferences_kept_after_typed_sync() {
    let test_app = build_test_app(TestAppOptions::with_database_runtime()).expect("test app");
    execute_sql(
        &test_app.main_webview,
        "INSERT INTO mcp_servers (id, name, transport_type)
         VALUES (9001, 'Local typed test', 'stdio')",
        json!([]),
    );
    execute_sql(
        &test_app.main_webview,
        "INSERT INTO mcp_tools (id, server_id, name, input_schema, enabled)
         VALUES (9001, 9001, 'old-tool', '{}', 0), (9002, 9001, 'removed-tool', '{}', 1)",
        json!([]),
    );

    let response = database_operation(
        &test_app.main_webview,
        json!({
            "kind": "mcp_tool_sync",
            "serverId": 9001,
            "tools": [
                {
                    "name": "old-tool",
                    "description": "Still here",
                    "inputSchema": { "type": "object" }
                },
                {
                    "name": "new-tool",
                    "description": "New",
                    "inputSchema": { "type": "object" }
                }
            ]
        }),
    );
    assert_eq!(response, serde_json::Value::Null);

    let tools = query_sql(
        &test_app.main_webview,
        "SELECT name, enabled FROM mcp_tools WHERE server_id = 9001 ORDER BY name",
        json!([]),
    );
    assert_eq!(
        tools["rows"],
        json!([
            { "name": "new-tool", "enabled": 1 },
            { "name": "old-tool", "enabled": 0 }
        ])
    );
}

#[test]
fn user_keeps_old_llm_metadata_when_a_typed_replace_is_invalid() {
    let test_app = build_test_app(TestAppOptions::with_database_runtime()).expect("test app");
    execute_sql(
        &test_app.main_webview,
        "INSERT INTO llm_metadata (model_id, name, modalities)
         VALUES ('old-model', 'Old', '{}')",
        json!([]),
    );
    execute_sql(
        &test_app.main_webview,
        "INSERT INTO llm_metadata_aliases (alias, model_id)
         VALUES ('old-alias', 'old-model')",
        json!([]),
    );

    let error = invoke_command_err(
        &test_app.main_webview,
        "database_operation",
        json!({
            "request": {
                "kind": "llm_metadata_replace",
                "metadata": [
                    {
                        "model_id": "new-model",
                        "name": "New",
                        "modalities": "{}",
                        "unsupported_column": true
                    }
                ],
                "aliases": [],
                "markUpdatedAt": true,
                "sourceEtag": "new-etag"
            }
        }),
    );
    assert_eq!(error["code"], "database-validation");

    assert_eq!(
        query_sql(
            &test_app.main_webview,
            "SELECT model_id, name FROM llm_metadata ORDER BY model_id",
            json!([]),
        )["rows"],
        json!([{ "model_id": "old-model", "name": "Old" }])
    );
    assert_eq!(
        query_sql(
            &test_app.main_webview,
            "SELECT alias, model_id FROM llm_metadata_aliases ORDER BY alias",
            json!([]),
        )["rows"],
        json!([{ "alias": "old-alias", "model_id": "old-model" }])
    );
}

#[test]
fn user_keeps_built_in_tool_state_when_a_typed_bulk_update_is_invalid() {
    let test_app = build_test_app(TestAppOptions::with_database_runtime()).expect("test app");
    execute_sql(
        &test_app.main_webview,
        "INSERT INTO built_in_tools (id, tool_id, display_name, enabled)
         VALUES (9001, 'first-typed-test', 'First', 1), (9002, 'second-typed-test', 'Second', 1)",
        json!([]),
    );

    let error = invoke_command_err(
        &test_app.main_webview,
        "database_operation",
        json!({
            "request": {
                "kind": "built_in_tool_update_many",
                "ids": [9001, 999999],
                "data": { "enabled": 0 }
            }
        }),
    );
    assert_eq!(error["code"], "built-in-tool-not-found");

    assert_eq!(
        query_sql(
            &test_app.main_webview,
            "SELECT id, enabled FROM built_in_tools WHERE id IN (9001, 9002) ORDER BY id",
            json!([]),
        )["rows"],
        json!([
            { "id": 9001, "enabled": 1 },
            { "id": 9002, "enabled": 1 }
        ])
    );
}

#[test]
fn user_finds_a_conversation_by_its_ordered_message_parts() {
    let test_app = build_test_app(TestAppOptions::with_database_runtime()).expect("test app");
    execute_sql(
        &test_app.main_webview,
        "INSERT INTO sessions (id, session_id, title, model)
         VALUES (3001, 'typed-session-search', 'Weekly planning', 'gpt-test')",
        json!([]),
    );
    execute_sql(
        &test_app.main_webview,
        "INSERT INTO messages (id, session_id, role)
         VALUES (3101, 3001, 'assistant')",
        json!([]),
    );
    execute_sql(
        &test_app.main_webview,
        "INSERT INTO message_parts (message_id, type, content, sort_order)
         VALUES (3101, 'text', 'Quarterly ', 0), (3101, 'text', 'budget review', 1)",
        json!([]),
    );

    let sessions = database_operation(
        &test_app.main_webview,
        json!({ "kind": "session_list", "query": "budget", "limit": 40 }),
    );

    assert_eq!(sessions.as_array().expect("session array").len(), 1);
    assert_eq!(sessions[0]["id"], 3001);
    assert_eq!(sessions[0]["title"], "Weekly planning");
}

#[test]
fn user_reopens_a_conversation_from_one_consistent_history_snapshot() {
    let test_app = build_test_app(TestAppOptions::with_database_runtime()).expect("test app");
    execute_sql(
        &test_app.main_webview,
        "INSERT INTO providers (id, name, driver, api_endpoint, logo, enabled)
         VALUES (7004, 'History Provider', 'openai', 'https://history.example/v1', 'openai.png', 1);
         INSERT INTO models (id, provider_id, name, model_id)
         VALUES (1004, 7004, 'History Model', 'history-model');
         INSERT INTO sessions (id, session_id, title, model, provider_id)
         VALUES (3004, 'typed-session-history', 'History', 'history-model', 7004);
         INSERT INTO messages (id, session_id, role)
         VALUES (3104, 3004, 'user'), (3105, 3004, 'assistant');
         INSERT INTO attachments (id, hash, type, original_name, origin_path, mime_type, size)
         VALUES (3304, 'history-hash', 'file', 'notes.txt', '/tmp/notes.txt', 'text/plain', 12);
         INSERT INTO message_parts (id, message_id, type, content, data, sort_order)
         VALUES (3501, 3104, 'text', 'Read the file', '{}', 0),
                (3502, 3104, 'attachment', '', '{\"attachmentId\":3304,\"originPath\":\"/tmp/notes.txt\"}', 1),
                (3503, 3105, 'text', 'The file is short', '{}', 0);
         INSERT INTO session_turns (
             id, session_id, model_id, task_id, prompt_snapshot_json,
             prompt_message_id, response_message_id, status
         )
         VALUES (3204, 3004, 1004, 'history-task', '{\"prompt\":\"Read\"}', 3104, 3105, 'completed');
         INSERT INTO session_turn_attempts (
             id, turn_id, attempt_index, max_retries, status,
             checkpoint_json, delivery_manifest_json, started_at
         )
         VALUES (3404, 3204, 1, 2, 'completed', '{\"step\":1}', '{\"mode\":\"full\"}', '2026-01-01T00:00:00Z')",
        json!([]),
    );

    let history = database_operation(
        &test_app.main_webview,
        json!({ "kind": "session_history", "sessionId": 3004 }),
    );

    assert_eq!(history["session"]["id"], 3004);
    assert_eq!(history["messages"].as_array().expect("messages").len(), 2);
    assert_eq!(
        history["messages"][0]["parts"][0]["content"],
        "Read the file"
    );
    assert_eq!(history["messages"][0]["parts"][1]["type"], "attachment");
    assert_eq!(history["messages"][0]["attachments"][0]["id"], 3304);
    assert_eq!(
        history["messages"][0]["attachments"][0]["origin_path"],
        "/tmp/notes.txt"
    );
    assert_eq!(history["turns"][0]["task_id"], "history-task");
    assert_eq!(
        history["attempts"][0]["delivery_manifest_json"],
        "{\"mode\":\"full\"}"
    );
    assert_eq!(history["model"]["id"], 1004);
    assert_eq!(history["model"]["provider_name"], "History Provider");

    let messages = database_operation(
        &test_app.main_webview,
        json!({ "kind": "session_messages", "sessionId": 3004 }),
    );
    assert_eq!(messages.as_array().expect("message array").len(), 2);
    assert_eq!(messages[1]["parts"][0]["content"], "The file is short");
}

#[test]
fn user_gets_one_attachment_row_when_the_same_bytes_are_sent_twice() {
    let test_app = build_test_app(TestAppOptions::with_database_runtime()).expect("test app");
    let request = json!({
        "kind": "attachment_ensure",
        "input": {
            "hash": "same-content-hash",
            "type": "file",
            "originalName": "report.pdf",
            "originPath": "/downloads/report.pdf",
            "mimeType": "application/pdf",
            "size": 2048
        }
    });

    let first = database_operation(&test_app.main_webview, request.clone());
    let second = database_operation(&test_app.main_webview, request);

    assert_eq!(first["id"], second["id"]);
    assert_eq!(
        query_sql(
            &test_app.main_webview,
            "SELECT COUNT(*) AS count FROM attachments WHERE hash = 'same-content-hash'",
            json!([]),
        )["rows"],
        json!([{ "count": 1 }])
    );
}

#[test]
fn user_clears_conversation_data_in_dependency_safe_typed_transactions() {
    let test_app = build_test_app(TestAppOptions::with_database_runtime()).expect("test app");
    execute_sql(
        &test_app.main_webview,
        "INSERT INTO providers (id, name, driver, api_endpoint, logo)
         VALUES (7005, 'Cleanup Provider', 'openai', 'https://cleanup.example/v1', 'openai.png');
         INSERT INTO models (id, provider_id, name, model_id)
         VALUES (1005, 7005, 'Cleanup Model', 'cleanup-model');
         INSERT INTO sessions (id, session_id, title, model)
         VALUES (3005, 'typed-session-cleanup', 'Cleanup', 'cleanup-model');
         INSERT INTO messages (id, session_id, role)
         VALUES (3106, 3005, 'user'), (3107, 3005, 'assistant');
         INSERT INTO message_parts (message_id, type, content, sort_order)
         VALUES (3106, 'text', 'Question', 0), (3107, 'text', 'Answer', 0);
         INSERT INTO session_turns (
             id, session_id, model_id, task_id, prompt_snapshot_json,
             prompt_message_id, response_message_id, status
         )
         VALUES (3205, 3005, 1005, 'cleanup-task', '{}', 3106, 3107, 'completed');
         INSERT INTO session_turn_attempts (
             id, turn_id, attempt_index, checkpoint_json, delivery_manifest_json
         )
         VALUES (3405, 3205, 1, '{}', '{}')",
        json!([]),
    );

    assert_eq!(
        database_operation(&test_app.main_webview, json!({ "kind": "message_count" })),
        json!(2)
    );
    assert_eq!(
        database_operation(
            &test_app.main_webview,
            json!({ "kind": "session_turn_count" })
        ),
        json!(1)
    );

    database_operation(
        &test_app.main_webview,
        json!({ "kind": "message_delete_all" }),
    );
    assert_eq!(
        query_sql(
            &test_app.main_webview,
            "SELECT
                 (SELECT COUNT(*) FROM messages) AS messages,
                 (SELECT COUNT(*) FROM message_parts) AS parts,
                 (SELECT COUNT(*) FROM session_turns) AS turns",
            json!([]),
        )["rows"],
        json!([{ "messages": 0, "parts": 0, "turns": 1 }])
    );

    database_operation(
        &test_app.main_webview,
        json!({ "kind": "session_turn_delete_all" }),
    );
    assert_eq!(
        query_sql(
            &test_app.main_webview,
            "SELECT
                 (SELECT COUNT(*) FROM session_turns) AS turns,
                 (SELECT COUNT(*) FROM session_turn_attempts) AS attempts,
                 (SELECT COUNT(*) FROM sessions) AS sessions",
            json!([]),
        )["rows"],
        json!([{ "turns": 0, "attempts": 0, "sessions": 1 }])
    );
}

#[test]
fn user_reuses_one_attachment_reference_per_provider_transport() {
    let test_app = build_test_app(TestAppOptions::with_database_runtime()).expect("test app");
    execute_sql(
        &test_app.main_webview,
        "INSERT INTO providers (id, name, driver, api_endpoint, logo)
         VALUES (7006, 'Remote Ref Provider', 'openai', 'https://remote.example/v1', 'openai.png');
         INSERT INTO attachments (id, hash, type, original_name, origin_path)
         VALUES (3306, 'remote-ref-hash', 'file', 'remote.pdf', '/tmp/remote.pdf')",
        json!([]),
    );

    let first = database_operation(
        &test_app.main_webview,
        json!({
            "kind": "attachment_remote_ref_upsert",
            "data": {
                "attachment_id": 3306,
                "provider_id": 7006,
                "transport_kind": "openai-file-id",
                "remote_ref": "file-old",
                "mime_type": "application/pdf",
                "expires_at": null,
                "last_used_at": "2026-01-01T00:00:00.000Z",
                "created_at": "2026-01-01T00:00:00.000Z",
                "updated_at": "2026-01-01T00:00:00.000Z"
            }
        }),
    );
    let second = database_operation(
        &test_app.main_webview,
        json!({
            "kind": "attachment_remote_ref_upsert",
            "data": {
                "attachment_id": 3306,
                "provider_id": 7006,
                "transport_kind": "openai-file-id",
                "remote_ref": "file-new",
                "mime_type": "application/pdf",
                "expires_at": "2027-01-01T00:00:00.000Z",
                "last_used_at": "2026-02-01T00:00:00.000Z",
                "updated_at": "2026-02-01T00:00:00.000Z"
            }
        }),
    );

    assert_eq!(first["id"], second["id"]);
    assert_eq!(second["remote_ref"], "file-new");
    assert_eq!(second["created_at"], "2026-01-01T00:00:00.000Z");
    assert_eq!(second["updated_at"], "2026-02-01T00:00:00.000Z");
    let found = database_operation(
        &test_app.main_webview,
        json!({
            "kind": "attachment_remote_ref_find",
            "attachmentId": 3306,
            "providerId": 7006,
            "transportKind": "openai-file-id"
        }),
    );
    assert_eq!(found["remote_ref"], "file-new");

    database_operation(
        &test_app.main_webview,
        json!({
            "kind": "attachment_remote_ref_touch",
            "id": second["id"],
            "lastUsedAt": "2026-03-01T00:00:00.000Z"
        }),
    );
    assert_eq!(
        query_sql(
            &test_app.main_webview,
            "SELECT COUNT(*) AS count, MAX(last_used_at) AS last_used_at
             FROM attachment_remote_refs",
            json!([]),
        )["rows"],
        json!([{ "count": 1, "last_used_at": "2026-03-01T00:00:00.000Z" }])
    );
}

#[test]
fn user_sees_and_dismisses_the_latest_terminal_badge() {
    let test_app = build_test_app(TestAppOptions::with_database_runtime()).expect("test app");
    execute_sql(
        &test_app.main_webview,
        "INSERT INTO providers (id, name, driver, api_endpoint, logo)
         VALUES (7001, 'Typed session provider', 'openai', 'https://provider.example/v1', 'openai.png')",
        json!([]),
    );
    execute_sql(
        &test_app.main_webview,
        "INSERT INTO models (id, provider_id, name, model_id)
         VALUES (1001, 7001, 'Typed model', 'typed-model')",
        json!([]),
    );
    execute_sql(
        &test_app.main_webview,
        "INSERT INTO sessions (id, session_id, title, model)
         VALUES (3002, 'typed-session-badge', 'Badge', 'typed-model');
         INSERT INTO session_turns (id, session_id, model_id, task_id, prompt_snapshot_json, status)
         VALUES (3201, 3002, 1001, 'typed-task', '{}', 'completed')",
        json!([]),
    );

    let before = database_operation(
        &test_app.main_webview,
        json!({ "kind": "session_find_by_id", "id": 3002 }),
    );
    assert_eq!(before["pending_terminal_status"], "completed");

    let dismissed = database_operation(
        &test_app.main_webview,
        json!({ "kind": "session_dismiss_terminal_status", "id": 3002 }),
    );
    assert_eq!(dismissed, serde_json::Value::Null);

    let after = database_operation(
        &test_app.main_webview,
        json!({ "kind": "session_find_by_id", "id": 3002 }),
    );
    assert_eq!(after["pending_terminal_status"], serde_json::Value::Null);
}

#[test]
fn user_keeps_the_selected_provider_until_a_turn_records_another_model() {
    let test_app = build_test_app(TestAppOptions::with_database_runtime()).expect("test app");
    execute_sql(
        &test_app.main_webview,
        "INSERT INTO providers (id, name, driver, api_endpoint, logo)
         VALUES (7002, 'Selected', 'openai', 'https://selected.example/v1', 'selected.png'),
                (8002, 'Recorded', 'openai', 'https://recorded.example/v1', 'recorded.png');
         INSERT INTO models (id, provider_id, name, model_id)
         VALUES (1002, 7002, 'Selected model', 'selected-model'),
                (1003, 8002, 'Recorded model', 'recorded-model');
         INSERT INTO sessions (id, session_id, title, model, provider_id)
         VALUES (3003, 'typed-session-provider', 'Provider', 'selected-model', 7002)",
        json!([]),
    );

    database_operation(
        &test_app.main_webview,
        json!({ "kind": "session_refresh_metadata", "id": 3003 }),
    );
    assert_eq!(
        query_sql(
            &test_app.main_webview,
            "SELECT provider_id FROM sessions WHERE id = 3003",
            json!([]),
        )["rows"],
        json!([{ "provider_id": 7002 }])
    );

    execute_sql(
        &test_app.main_webview,
        "INSERT INTO session_turns (session_id, model_id, task_id, prompt_snapshot_json)
         VALUES (3003, 1003, 'typed-provider-task', '{}')",
        json!([]),
    );
    database_operation(
        &test_app.main_webview,
        json!({ "kind": "session_refresh_metadata", "id": 3003 }),
    );
    assert_eq!(
        query_sql(
            &test_app.main_webview,
            "SELECT provider_id FROM sessions WHERE id = 3003",
            json!([]),
        )["rows"],
        json!([{ "provider_id": 8002 }])
    );
}

#[test]
fn user_cannot_read_agent_sessions_from_settings_or_popup_windows() {
    let test_app = build_test_app(TestAppOptions::with_database_runtime()).expect("test app");
    let settings = WebviewWindowBuilder::new(&test_app.app, "settings", WebviewUrl::default())
        .build()
        .expect("settings window");
    let popup = WebviewWindowBuilder::new(
        &test_app.app,
        "popup-session-permission-test",
        WebviewUrl::default(),
    )
    .build()
    .expect("popup window");

    for webview in [&settings, &popup] {
        let error = invoke_command_err(
            webview,
            "database_operation",
            json!({ "request": { "kind": "session_list", "limit": 40 } }),
        );
        assert_eq!(error["code"], "database-forbidden");
    }
}

#[test]
fn user_can_read_usage_but_cannot_write_usage_detail_from_the_settings_window() {
    let test_app = build_test_app(TestAppOptions::with_database_runtime()).expect("test app");
    let settings = WebviewWindowBuilder::new(&test_app.app, "settings", WebviewUrl::default())
        .build()
        .expect("settings window");

    database_operation(
        &settings,
        json!({
            "kind": "usage_summary",
            "filter": {
                "from": "2026-01-01 00:00:00",
                "to": "2026-12-31 23:59:59"
            }
        }),
    );
    let error = invoke_command_err(
        &settings,
        "database_operation",
        json!({
            "request": {
                "kind": "usage_append_llm_call_parts",
                "messageId": 1,
                "calls": [{ "data": "{}" }]
            }
        }),
    );
    assert_eq!(error["code"], "database-forbidden");
}

#[test]
fn user_cannot_use_a_preview_window_to_read_settings() {
    let test_app = build_test_app(TestAppOptions::with_database_runtime()).expect("test app");
    let preview = WebviewWindowBuilder::new(&test_app.app, "preview-test", WebviewUrl::default())
        .build()
        .expect("preview window");

    let error = invoke_command_err(
        &preview,
        "database_operation",
        json!({
            "request": {
                "kind": "setting_get",
                "key": "language"
            }
        }),
    );

    assert_eq!(error["code"], "database-forbidden");
}

#[test]
fn database_query_rejects_top_level_transaction_sql() {
    let test_app = build_test_app(TestAppOptions::with_database_runtime()).expect("test app");

    let error = invoke_command_err(
        &test_app.main_webview,
        "database_query",
        json!({
            "request": {
                "sql": "BEGIN IMMEDIATE",
                "method": "run"
            }
        }),
    );

    assert_eq!(
        error,
        json!("Top-level database_query 不允许直接发送事务控制 SQL")
    );
}

#[test]
fn database_transaction_commands_persist_changes_after_commit() {
    let test_app = build_test_app(TestAppOptions::with_database_runtime()).expect("test app");

    let tx_id: String = invoke_command_ok(
        &test_app.main_webview,
        "database_tx_begin",
        json!({
            "behavior": "immediate"
        }),
    );

    let insert_response: serde_json::Value = invoke_command_ok(
        &test_app.main_webview,
        "database_tx_query",
        json!({
            "txId": tx_id,
            "request": {
                "sql": "INSERT INTO sessions (id, session_id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                "params": [1001, "session_rust_test_1001", "rust-test-session", "gpt-test", "2026-05-16 00:00:00", "2026-05-16 00:00:00"],
                "method": "run"
            }
        }),
    );

    assert_eq!(insert_response["rowsAffected"], 1);

    let commit_response: () = invoke_command_ok(
        &test_app.main_webview,
        "database_tx_commit",
        json!({
            "txId": tx_id
        }),
    );
    assert_eq!(commit_response, ());

    let persisted: serde_json::Value = invoke_command_ok(
        &test_app.main_webview,
        "database_query",
        json!({
            "request": {
                "sql": "SELECT title FROM sessions WHERE id = ?",
                "params": [1001],
                "method": "get"
            }
        }),
    );

    assert_eq!(
        persisted,
        json!({
            "rows": [
                { "title": "rust-test-session" }
            ],
            "rowsAffected": 0,
            "lastInsertId": null
        })
    );
}

#[test]
fn quick_search_click_stats_upsert_uses_declared_conflict_target() {
    let test_app = build_test_app(TestAppOptions::with_database_runtime()).expect("test app");
    let upsert_sql = "INSERT INTO quick_search_click_stats (query_norm, path_norm, click_count) \
        VALUES (?, ?, 1) \
        ON CONFLICT(query_norm, path_norm) DO UPDATE SET \
        click_count = quick_search_click_stats.click_count + 1";

    for _ in 0..2 {
        let response: serde_json::Value = invoke_command_ok(
            &test_app.main_webview,
            "database_query",
            json!({
                "request": {
                    "sql": upsert_sql,
                    "params": ["touch ai", "d:\\tool.lnk"],
                    "method": "run"
                }
            }),
        );

        assert_eq!(response["rowsAffected"], 1);
    }

    let row: serde_json::Value = invoke_command_ok(
        &test_app.main_webview,
        "database_query",
        json!({
            "request": {
                "sql": "SELECT query_norm, path_norm, click_count FROM quick_search_click_stats WHERE query_norm = ? AND path_norm = ?",
                "params": ["touch ai", "d:\\tool.lnk"],
                "method": "get"
            }
        }),
    );

    assert_eq!(
        row,
        json!({
            "rows": [
                {
                    "query_norm": "touch ai",
                    "path_norm": "d:\\tool.lnk",
                    "click_count": 2
                }
            ],
            "rowsAffected": 0,
            "lastInsertId": null
        })
    );
}

#[test]
fn database_tx_query_reports_missing_transactions() {
    let test_app = build_test_app(TestAppOptions::with_database_runtime()).expect("test app");

    let error = invoke_command_err(
        &test_app.main_webview,
        "database_tx_query",
        json!({
            "txId": "tx_missing",
            "request": {
                "sql": "SELECT 1",
                "method": "get"
            }
        }),
    );

    assert_eq!(error, json!("Transaction 'tx_missing' was not found"));
}

#[test]
fn user_exports_a_consistent_database_backup() {
    let test_app = build_test_app(TestAppOptions::with_database_runtime()).expect("test app");
    let target_dir = tempfile::tempdir().expect("backup destination");
    let target = target_dir.path().join("touchai.db");

    let response: () = invoke_command_ok(
        &test_app.main_webview,
        "database_export_backup",
        json!({
            "request": {
                "targetPath": target.to_string_lossy()
            }
        }),
    );
    assert_eq!(response, ());

    tauri::async_runtime::block_on(async {
        let mut connection =
            sqlx::SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&target))
                .await
                .expect("open exported backup");
        let app_id: String =
            sqlx::query_scalar("SELECT value FROM touchai_meta WHERE key = 'app_id'")
                .fetch_one(&mut connection)
                .await
                .expect("read exported metadata");
        assert_eq!(app_id, "touchai");
        let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
            .fetch_one(&mut connection)
            .await
            .expect("check exported database");
        assert_eq!(integrity, "ok");
        connection.close().await.expect("close exported backup");
    });
}

#[test]
fn user_can_use_main_and_settings_windows_for_backup_operations() {
    let test_app = build_test_app(TestAppOptions::with_database_runtime()).expect("test app");
    let settings = WebviewWindowBuilder::new(&test_app.app, "settings", WebviewUrl::default())
        .build()
        .expect("settings window");
    let target_dir = tempfile::tempdir().expect("backup destination");

    for (index, webview) in [&test_app.main_webview, &settings].into_iter().enumerate() {
        let target = target_dir.path().join(format!("backup-{index}.db"));
        let response: () = invoke_command_ok(
            webview,
            "database_export_backup",
            json!({
                "request": {
                    "targetPath": target.to_string_lossy()
                }
            }),
        );
        assert_eq!(response, ());
        assert!(target.is_file());
    }
}

#[test]
fn user_cannot_use_popup_or_preview_windows_for_database_backups() {
    let test_app = build_test_app(TestAppOptions::with_database_runtime()).expect("test app");
    let popup = WebviewWindowBuilder::new(
        &test_app.app,
        "popup-backup-permission-test",
        WebviewUrl::default(),
    )
    .build()
    .expect("popup window");
    let preview =
        WebviewWindowBuilder::new(&test_app.app, "preview-backup-test", WebviewUrl::default())
            .build()
            .expect("preview window");
    let target_dir = tempfile::tempdir().expect("backup destination");
    let target = target_dir.path().join("forbidden.db");

    for webview in [&popup, &preview] {
        let export_error = invoke_command_err(
            webview,
            "database_export_backup",
            json!({
                "request": {
                    "targetPath": target.to_string_lossy()
                }
            }),
        );
        assert!(export_error
            .as_str()
            .unwrap_or_default()
            .contains("not allowed"));

        let import_error = invoke_command_err(
            webview,
            "database_import_backup",
            json!({
                "request": {
                    "sourcePath": "D:/non-existent.db",
                    "mode": "full"
                }
            }),
        );
        assert!(import_error
            .as_str()
            .unwrap_or_default()
            .contains("not allowed"));
    }
    assert!(!target.exists());
}

#[test]
fn database_import_backup_rejects_requests_while_a_transaction_is_open() {
    let test_app = build_test_app(TestAppOptions::with_database_runtime()).expect("test app");

    let tx_id: String = invoke_command_ok(
        &test_app.main_webview,
        "database_tx_begin",
        json!({
            "behavior": "deferred"
        }),
    );

    let error = invoke_command_err(
        &test_app.main_webview,
        "database_import_backup",
        json!({
            "request": {
                "sourcePath": "D:/non-existent.db",
                "mode": "full"
            }
        }),
    );

    assert_eq!(error, json!("当前仍有进行中的数据库事务，请稍后重试导入"));

    let rollback_response: () = invoke_command_ok(
        &test_app.main_webview,
        "database_tx_rollback",
        json!({
            "txId": tx_id
        }),
    );
    assert_eq!(rollback_response, ());
}

#[test]
fn database_search_index_supports_contentless_delete_on_bundled_sqlite() {
    let test_app = build_test_app(TestAppOptions::with_database_runtime()).expect("test app");
    let query = |sql: &str, params: serde_json::Value, method: &str| -> serde_json::Value {
        invoke_command_ok(
            &test_app.main_webview,
            "database_query",
            json!({ "request": { "sql": sql, "params": params, "method": method } }),
        )
    };
    query(
        "INSERT INTO sessions (id, session_id, title, model) VALUES (1001, 'fts-test', 'Search', 'test')",
        json!([]),
        "run",
    );
    query(
        "INSERT INTO messages (id, session_id, role) VALUES (1001, 1001, 'assistant')",
        json!([]),
        "run",
    );
    for (kind, content, order) in [
        ("text", "中文", 0),
        ("reasoning", "Hidden thought", 1),
        ("text", "搜索", 2),
    ] {
        query(
            "INSERT INTO message_parts (message_id, type, content, sort_order) VALUES (1001, ?, ?, ?)",
            json!([kind, content, order]),
            "run",
        );
    }
    let search = || {
        query(
            "SELECT rowid, content FROM message_search_fts WHERE message_search_fts MATCH ?",
            json!(["\"中文搜\""]),
            "all",
        )
    };
    assert_eq!(
        search()["rows"],
        json!([{ "rowid": 1001, "content": null }])
    );
    assert_eq!(
        query(
            "SELECT rowid FROM message_search_fts WHERE message_search_fts MATCH ?",
            json!(["\"Hid\""]),
            "all",
        )["rows"],
        json!([])
    );
    query(
        "UPDATE message_parts SET content = '答案' WHERE message_id = 1001 AND sort_order = 2",
        json!([]),
        "run",
    );
    assert_eq!(search()["rows"], json!([]));
    query("DELETE FROM sessions WHERE id = 1001", json!([]), "run");
    assert_eq!(
        query("SELECT rowid FROM message_search_fts", json!([]), "all")["rows"],
        json!([])
    );
}

#[test]
fn user_gets_atomic_tool_part_create_list_and_update_through_typed_operations() {
    let test_app = build_test_app(TestAppOptions::with_database_runtime()).expect("test app");
    execute_sql(
        &test_app.main_webview,
        "INSERT INTO sessions (id, session_id, title, model)
         VALUES (1001, 'typed-tool-parts', 'Tool parts', 'gpt-test')",
        json!([]),
    );
    execute_sql(
        &test_app.main_webview,
        "INSERT INTO messages (id, session_id, role) VALUES (1001, 1001, 'assistant')",
        json!([]),
    );

    let created = database_operation(
        &test_app.main_webview,
        json!({
            "kind": "tool_part_create",
            "toolKind": "builtin",
            "data": {
                "message_id": 1001,
                "tool_call_id": "call-typed-1",
                "tool_id": "shell",
                "input": "{}",
                "status": "streaming"
            }
        }),
    );
    assert_eq!(created["tool_call_id"], "call-typed-1");
    assert_eq!(created["status"], "streaming");
    assert_eq!(created["toolKind"], "builtin");

    let listed = database_operation(
        &test_app.main_webview,
        json!({
            "kind": "tool_part_list",
            "toolKind": "builtin",
            "filter": { "kind": "tool_id", "toolId": "shell" }
        }),
    );
    assert_eq!(listed.as_array().expect("tool part list").len(), 1);
    assert_eq!(listed[0]["id"], created["id"]);

    let updated = database_operation(
        &test_app.main_webview,
        json!({
            "kind": "tool_part_update",
            "toolKind": "builtin",
            "filter": { "kind": "id", "id": created["id"] },
            "data": { "status": "success", "output": "done" }
        }),
    );
    assert_eq!(updated["status"], "success");
    assert_eq!(updated["output"], "done");
    assert_eq!(updated["message_id"], 1001);

    let persisted = query_sql(
        &test_app.main_webview,
        "SELECT json_extract(data, '$.status') AS status,
                json_extract(data, '$.output') AS output,
                tool_call_id,
                tool_kind
         FROM message_parts
         WHERE id = ?",
        json!([created["id"]]),
    );
    assert_eq!(
        persisted["rows"],
        json!([{
            "status": "success",
            "output": "done",
            "tool_call_id": "call-typed-1",
            "tool_kind": "builtin"
        }])
    );
}

#[test]
fn user_gets_a_parent_tool_message_when_the_typed_create_has_only_a_session() {
    let test_app = build_test_app(TestAppOptions::with_database_runtime()).expect("test app");
    execute_sql(
        &test_app.main_webview,
        "INSERT INTO sessions (id, session_id, title, model)
         VALUES (1001, 'typed-tool-parent', 'Tool parent', 'gpt-test')",
        json!([]),
    );

    let created = database_operation(
        &test_app.main_webview,
        json!({
            "kind": "tool_part_create",
            "toolKind": "mcp",
            "data": {
                "session_id": 1001,
                "tool_call_id": "call-typed-parent",
                "server_id": 7,
                "tool_name": "search",
                "input": "{}"
            }
        }),
    );
    assert_eq!(created["session_id"], 1001);
    assert_eq!(created["tool_call_id"], "call-typed-parent");

    let parent = query_sql(
        &test_app.main_webview,
        "SELECT role FROM messages WHERE id = ?",
        json!([created["message_id"]]),
    );
    assert_eq!(parent["rows"], json!([{ "role": "tool_call" }]));
}

fn seed_task_model(webview: &tauri::WebviewWindow<tauri::test::MockRuntime>) {
    execute_sql(
        webview,
        "INSERT INTO providers (id, name, driver, api_endpoint, logo)
         VALUES (7101, 'Task provider', 'openai', 'https://task.example/v1', 'openai.png')",
        json!([]),
    );
    execute_sql(
        webview,
        "INSERT INTO models (id, provider_id, name, model_id)
         VALUES (7102, 7101, 'Task model', 'task-model')",
        json!([]),
    );
}

fn start_typed_task(webview: &tauri::WebviewWindow<tauri::test::MockRuntime>) -> serde_json::Value {
    seed_task_model(webview);
    database_operation(
        webview,
        json!({
            "kind": "task_record_start",
            "input": {
                "sessionId": null,
                "sessionTitle": "Typed task",
                "modelId": 7102,
                "modelName": "task-model",
                "providerId": 7101,
                "taskId": "task-typed-start",
                "executionMode": "foreground",
                "prompt": "Plan the release",
                "promptSnapshotJson": "{\"version\":1}",
                "promptBreakdownJson": "{\"prompt\":19}",
                "checkpointJson": "{\"iteration\":1}",
                "deliveryManifestJson": "{\"attachments\":[]}",
                "startedAt": "2026-11-05 10:00:00",
                "maxRetries": 2,
                "existingUserMessageId": null,
                "existingTurnId": null,
                "existingAttemptId": null,
                "attachments": []
            }
        }),
    )
}

fn terminal_behavior() -> serde_json::Value {
    json!({
        "firstTextMs": 120,
        "toolCallCount": 0,
        "toolArgumentErrorCount": 0,
        "modelSwitchCount": 0,
        "hitIterationCeiling": false,
        "errorCode": null,
        "retryScope": null
    })
}

fn usage_summary(input_tokens: i64, output_tokens: i64) -> serde_json::Value {
    json!({
        "inputTokens": input_tokens,
        "outputTokens": output_tokens,
        "cacheReadTokens": 0,
        "cacheWriteTokens": 0,
        "reasoningTokens": 0,
        "totalCostMicros": 0,
        "unpricedCalls": 0,
        "ttftMs": 120,
        "llmCallCount": 1
    })
}

#[test]
fn user_gets_a_session_prompt_turn_and_attempt_from_one_typed_start() {
    let test_app = build_test_app(TestAppOptions::with_database_runtime()).expect("test app");

    let started = start_typed_task(&test_app.main_webview);
    let session_id = started["session_id"].as_i64().expect("session id");
    let user_message_id = started["user_message_id"]
        .as_i64()
        .expect("user message id");
    let turn_id = started["turn"]["id"].as_i64().expect("turn id");
    let attempt_id = started["attempt"]["id"].as_i64().expect("attempt id");

    assert_eq!(started["turn"]["task_id"], "task-typed-start");
    assert_eq!(started["turn"]["prompt_message_id"], user_message_id);
    assert_eq!(started["attempt"]["turn_id"], turn_id);
    assert_eq!(started["attempt"]["attempt_index"], 1);

    assert_eq!(
        query_sql(
            &test_app.main_webview,
            "SELECT title, model, provider_id FROM sessions WHERE id = ?",
            json!([session_id]),
        )["rows"],
        json!([{
            "title": "Typed task",
            "model": "task-model",
            "provider_id": 7101
        }])
    );
    assert_eq!(
        query_sql(
            &test_app.main_webview,
            "SELECT content FROM message_parts WHERE message_id = ? ORDER BY sort_order",
            json!([user_message_id]),
        )["rows"],
        json!([{ "content": "Plan the release" }])
    );
    assert_eq!(
        query_sql(
            &test_app.main_webview,
            "SELECT status, prompt_breakdown_json FROM session_turns WHERE id = ?",
            json!([turn_id]),
        )["rows"],
        json!([{
            "status": "streaming",
            "prompt_breakdown_json": "{\"prompt\":19}"
        }])
    );
    assert_eq!(
        query_sql(
            &test_app.main_webview,
            "SELECT status, max_retries, checkpoint_json FROM session_turn_attempts WHERE id = ?",
            json!([attempt_id]),
        )["rows"],
        json!([{
            "status": "streaming",
            "max_retries": 2,
            "checkpoint_json": "{\"iteration\":1}"
        }])
    );
}

#[test]
fn user_gets_the_output_message_usage_attempt_and_turn_committed_together() {
    let test_app = build_test_app(TestAppOptions::with_database_runtime()).expect("test app");
    let started = start_typed_task(&test_app.main_webview);
    let turn_id = started["turn"]["id"].as_i64().expect("turn id");
    let attempt_id = started["attempt"]["id"].as_i64().expect("attempt id");

    let finished = database_operation(
        &test_app.main_webview,
        json!({
            "kind": "task_finish",
            "input": {
                "sessionId": started["session_id"],
                "turnId": turn_id,
                "attemptId": attempt_id,
                "assistantMessageId": null,
                "pendingMessageId": null,
                "status": "completed",
                "errorMessage": null,
                "durationMs": 2500,
                "tokensUsed": 30,
                "finishedAt": "2026-11-05 10:00:03",
                "parts": [{ "type": "text", "content": "Release ready" }],
                "usage": {
                    "calls": [{ "data": "{\"inputTokens\":12}" }],
                    "summary": usage_summary(12, 8)
                },
                "behavior": terminal_behavior(),
                "turnBootstrap": null
            }
        }),
    );
    let assistant_message_id = finished["assistant_message_id"]
        .as_i64()
        .expect("assistant message id");

    assert_eq!(finished["turn"]["status"], "completed");
    assert_eq!(finished["attempt"]["status"], "completed");
    assert_eq!(
        query_sql(
            &test_app.main_webview,
            "SELECT role FROM messages WHERE id = ?",
            json!([assistant_message_id]),
        )["rows"],
        json!([{ "role": "assistant" }])
    );
    assert_eq!(
        query_sql(
            &test_app.main_webview,
            "SELECT type, content FROM message_parts
             WHERE message_id = ? ORDER BY sort_order",
            json!([assistant_message_id]),
        )["rows"],
        json!([
            { "type": "text", "content": "Release ready" },
            { "type": "llm_call", "content": "" }
        ])
    );
    assert_eq!(
        query_sql(
            &test_app.main_webview,
            "SELECT status, input_tokens, output_tokens, llm_call_count, ttft_ms
             FROM session_turn_attempts WHERE id = ?",
            json!([attempt_id]),
        )["rows"],
        json!([{
            "status": "completed",
            "input_tokens": 12,
            "output_tokens": 8,
            "llm_call_count": 1,
            "ttft_ms": 120
        }])
    );
    assert_eq!(
        query_sql(
            &test_app.main_webview,
            "SELECT status, tokens_used, response_message_id, input_tokens,
                    output_tokens, llm_call_count, ttft_ms
             FROM session_turns WHERE id = ?",
            json!([turn_id]),
        )["rows"],
        json!([{
            "status": "completed",
            "tokens_used": 30,
            "response_message_id": assistant_message_id,
            "input_tokens": 12,
            "output_tokens": 8,
            "llm_call_count": 1,
            "ttft_ms": 120
        }])
    );
}

#[test]
fn user_keeps_task_state_unchanged_when_a_typed_finish_fails_mid_transaction() {
    let test_app = build_test_app(TestAppOptions::with_database_runtime()).expect("test app");
    let started = start_typed_task(&test_app.main_webview);
    let turn_id = started["turn"]["id"].as_i64().expect("turn id");
    let attempt_id = started["attempt"]["id"].as_i64().expect("attempt id");

    let error = invoke_command_err(
        &test_app.main_webview,
        "database_operation",
        json!({
            "request": {
                "kind": "task_finish",
                "input": {
                    "sessionId": started["session_id"],
                    "turnId": turn_id,
                    "attemptId": attempt_id,
                    "assistantMessageId": null,
                    "pendingMessageId": null,
                    "status": "completed",
                    "errorMessage": null,
                    "durationMs": 2500,
                    "tokensUsed": 30,
                    "finishedAt": "2026-11-05 10:00:03",
                    "parts": [{ "type": "text", "content": "Must roll back" }],
                    "usage": {
                        "calls": [{ "data": "not-json" }],
                        "summary": usage_summary(12, 8)
                    },
                    "behavior": terminal_behavior(),
                    "turnBootstrap": null
                }
            }
        }),
    );
    assert_eq!(error["code"], "database-validation");

    assert_eq!(
        query_sql(
            &test_app.main_webview,
            "SELECT COUNT(*) AS count FROM messages WHERE role = 'assistant'",
            json!([]),
        )["rows"],
        json!([{ "count": 0 }])
    );
    assert_eq!(
        query_sql(
            &test_app.main_webview,
            "SELECT COUNT(*) AS count FROM message_parts",
            json!([]),
        )["rows"],
        json!([{ "count": 1 }])
    );
    assert_eq!(
        query_sql(
            &test_app.main_webview,
            "SELECT status, response_message_id FROM session_turns WHERE id = ?",
            json!([turn_id]),
        )["rows"],
        json!([{ "status": "streaming", "response_message_id": null }])
    );
    assert_eq!(
        query_sql(
            &test_app.main_webview,
            "SELECT status, input_tokens FROM session_turn_attempts WHERE id = ?",
            json!([attempt_id]),
        )["rows"],
        json!([{ "status": "streaming", "input_tokens": 0 }])
    );
}

#[test]
fn user_gets_the_previous_attempt_closed_and_the_next_one_open_atomically() {
    let test_app = build_test_app(TestAppOptions::with_database_runtime()).expect("test app");
    let started = start_typed_task(&test_app.main_webview);
    let turn_id = started["turn"]["id"].as_i64().expect("turn id");
    let attempt_id = started["attempt"]["id"].as_i64().expect("attempt id");

    let retried = database_operation(
        &test_app.main_webview,
        json!({
            "kind": "task_begin_next_attempt",
            "input": {
                "turnId": turn_id,
                "currentAttemptId": attempt_id,
                "currentAttemptIndex": 1,
                "errorMessage": "temporary failure",
                "durationMs": 900,
                "finishedAt": "2026-11-05 10:00:01",
                "attemptIndex": 2,
                "maxRetries": 2,
                "checkpointJson": "{\"iteration\":2}",
                "deliveryManifestJson": "{\"attachments\":[]}",
                "startedAt": "2026-11-05 10:00:02",
                "usage": {
                    "calls": [],
                    "summary": usage_summary(4, 2)
                },
                "behavior": terminal_behavior()
            }
        }),
    );

    assert_eq!(retried["attempt"]["attempt_index"], 2);
    assert_eq!(retried["attempt"]["status"], "streaming");
    assert_eq!(retried["turn"]["status"], "streaming");
    assert_eq!(
        query_sql(
            &test_app.main_webview,
            "SELECT attempt_index, status, error_message, input_tokens
             FROM session_turn_attempts WHERE turn_id = ? ORDER BY attempt_index",
            json!([turn_id]),
        )["rows"],
        json!([
            {
                "attempt_index": 1,
                "status": "failed",
                "error_message": "temporary failure",
                "input_tokens": 4
            },
            {
                "attempt_index": 2,
                "status": "streaming",
                "error_message": null,
                "input_tokens": 0
            }
        ])
    );
}

#[test]
fn user_can_finish_a_legacy_task_without_a_turn_or_attempt() {
    let test_app = build_test_app(TestAppOptions::with_database_runtime()).expect("test app");
    seed_task_model(&test_app.main_webview);
    execute_sql(
        &test_app.main_webview,
        "INSERT INTO sessions (id, session_id, title, model)
         VALUES (7201, 'legacy-task-session', 'Legacy task', 'task-model');
         INSERT INTO messages (id, session_id, role)
         VALUES (7202, 7201, 'user')",
        json!([]),
    );

    let finished = database_operation(
        &test_app.main_webview,
        json!({
            "kind": "task_finish",
            "input": {
                "sessionId": 7201,
                "turnId": null,
                "attemptId": null,
                "assistantMessageId": null,
                "pendingMessageId": null,
                "status": "completed",
                "errorMessage": null,
                "durationMs": 1000,
                "tokensUsed": 7,
                "finishedAt": "2026-11-05 10:00:03",
                "parts": null,
                "usage": null,
                "behavior": terminal_behavior(),
                "turnBootstrap": {
                    "modelId": 7102,
                    "taskId": "legacy-task",
                    "executionMode": "foreground",
                    "promptSnapshotJson": "{}",
                    "promptMessageId": 7202
                }
            }
        }),
    );

    assert_eq!(finished["attempt"], serde_json::Value::Null);
    assert_eq!(finished["assistant_message_id"], serde_json::Value::Null);
    assert_eq!(finished["turn"]["task_id"], "legacy-task");
    assert_eq!(finished["turn"]["prompt_message_id"], 7202);
    assert_eq!(finished["turn"]["status"], "completed");
    assert_eq!(
        query_sql(
            &test_app.main_webview,
            "SELECT COUNT(*) AS count FROM session_turn_attempts
             WHERE turn_id = ?",
            json!([finished["turn"]["id"]]),
        )["rows"],
        json!([{ "count": 0 }])
    );
}

#[test]
fn user_gets_typed_usage_aggregates_and_context_profiles_from_rust() {
    let test_app = build_test_app(TestAppOptions::with_database_runtime()).expect("test app");
    execute_sql(
        &test_app.main_webview,
        "INSERT INTO providers (id, name, driver, api_endpoint, logo)
         VALUES (8101, 'Usage Provider', 'openai', 'https://usage.example/v1', 'openai');
         INSERT INTO models (id, provider_id, name, model_id, context_limit)
         VALUES (9101, 8101, 'Usage Model', 'usage-model', 100000);
         INSERT INTO sessions (id, session_id, title, model, provider_id)
         VALUES (9201, 'usage-session', 'Usage session', 'usage-model', 8101);
         INSERT INTO session_turns (
             id, session_id, model_id, task_id, prompt_snapshot_json,
             prompt_breakdown_json, status, created_at, input_tokens, output_tokens,
             cache_read_tokens, cache_write_tokens, total_cost_micros, unpriced_calls,
             ttft_ms, first_text_ms, duration_ms
         ) VALUES
             (9301, 9201, 9101, 'usage-task-1', '{}',
              '{\"fragments\":{\"platform\":4000},\"userPrompt\":100,\"attachments\":50,\"builtinToolDefinitions\":200,\"mcpToolDefinitions\":300,\"systemPromptTotal\":5000}',
              'completed', '2026-05-01 10:00:00', 1000, 100, 500, 0, 10, 1, 100, 120, 1000),
             (9302, 9201, 9101, 'usage-task-2', '{}',
              '{\"fragments\":{\"platform\":4000},\"userPrompt\":100,\"attachments\":50,\"builtinToolDefinitions\":200,\"mcpToolDefinitions\":300,\"systemPromptTotal\":5000}',
              'failed', '2026-05-02 10:00:00', 2000, 200, 0, 0, 20, 0, NULL, NULL, 2000)",
        json!([]),
    );

    let filter = json!({
        "from": "2026-05-01 00:00:00",
        "to": "2026-05-03 23:59:59"
    });
    let summary = database_operation(
        &test_app.main_webview,
        json!({ "kind": "usage_summary", "filter": filter.clone() }),
    );
    assert_eq!(summary["requestCount"], 2);
    assert_eq!(summary["sessionCount"], 1);
    assert_eq!(summary["activeDayCount"], 2);
    assert_eq!(summary["inputTokens"], 3000);
    assert_eq!(summary["outputTokens"], 300);
    assert_eq!(summary["cacheReadTokens"], 500);
    assert_eq!(summary["totalCostMicros"], 30);
    assert_eq!(summary["unpricedCount"], 1);
    assert_eq!(summary["meanTtftMs"], 100);
    assert_eq!(summary["meanDurationMs"], 1500);

    let trend = database_operation(
        &test_app.main_webview,
        json!({
            "kind": "usage_trend",
            "filter": filter.clone(),
            "dimension": "model"
        }),
    );
    let trend_tokens = trend["points"]
        .as_array()
        .expect("trend points")
        .iter()
        .map(|point| point["tokens"].as_i64().unwrap_or_default())
        .sum::<i64>();
    assert_eq!(trend_tokens, 3800);
    assert_eq!(trend["points"][0]["segments"][0]["name"], "Usage Model");

    let composition = database_operation(
        &test_app.main_webview,
        json!({ "kind": "usage_composition", "filter": filter.clone() }),
    );
    let output = composition["tokens"]["segments"]
        .as_array()
        .expect("token segments")
        .iter()
        .find(|segment| segment["key"] == "output")
        .expect("output segment");
    assert_eq!(output["value"], 300);

    let profiles = database_operation(
        &test_app.main_webview,
        json!({ "kind": "usage_context_profiles", "filter": filter.clone() }),
    );
    assert_eq!(profiles["overall"]["turnCount"], 2);
    assert_eq!(profiles["models"][0]["modelName"], "Usage Model");

    let points = database_operation(
        &test_app.main_webview,
        json!({
            "kind": "usage_context_points",
            "filter": filter,
            "limit": 200
        }),
    );
    assert_eq!(points.as_array().expect("context points").len(), 2);
    assert_eq!(points[0]["promptTokens"].as_f64(), Some(1500.0));
    assert_eq!(points[1]["promptTokens"].as_f64(), Some(2000.0));
}

#[test]
fn user_gets_typed_usage_detail_rollup_prune_and_maintenance() {
    let test_app = build_test_app(TestAppOptions::with_database_runtime()).expect("test app");
    execute_sql(
        &test_app.main_webview,
        "INSERT INTO providers (id, name, driver, api_endpoint, logo)
         VALUES (8102, 'Usage Detail Provider', 'openai', 'https://detail.example/v1', 'openai');
         INSERT INTO models (id, provider_id, name, model_id)
         VALUES (9102, 8102, 'Usage Detail Model', 'usage-detail-model');
         INSERT INTO sessions (id, session_id, title, model)
         VALUES (9202, 'usage-detail-session', 'Usage detail', 'usage-detail-model');
         INSERT INTO messages (id, session_id, role)
         VALUES (9402, 9202, 'assistant');
         INSERT INTO session_turns (
             id, session_id, model_id, task_id, prompt_snapshot_json,
             status, created_at, input_tokens, output_tokens
         ) VALUES (9302, 9202, 9102, 'usage-detail-task', '{}',
                   'completed', '2026-05-01 10:00:00', 10, 20);
         INSERT INTO message_parts (id, message_id, type, content, sort_order)
         VALUES (9502, 9402, 'text', 'already here', 0)",
        json!([]),
    );

    let appended = database_operation(
        &test_app.main_webview,
        json!({
            "kind": "usage_append_llm_call_parts",
            "messageId": 9402,
            "calls": [
                {
                    "data": "{\"call\":1}",
                    "startedAt": 100,
                    "endedAt": 200
                },
                {
                    "data": "{\"call\":2}",
                    "startedAt": 300,
                    "endedAt": 400
                }
            ]
        }),
    );
    assert_eq!(appended, 2);
    assert_eq!(
        query_sql(
            &test_app.main_webview,
            "SELECT type, sort_order FROM message_parts
             WHERE message_id = 9402 ORDER BY sort_order",
            json!([]),
        )["rows"],
        json!([
            { "type": "text", "sort_order": 0 },
            { "type": "llm_call", "sort_order": 1 },
            { "type": "llm_call", "sort_order": 2 }
        ])
    );

    database_operation(
        &test_app.main_webview,
        json!({ "kind": "usage_rollup_daily" }),
    );
    assert_eq!(
        query_sql(
            &test_app.main_webview,
            "SELECT request_count, input_tokens, output_tokens
             FROM usage_daily_rollups",
            json!([]),
        )["rows"],
        json!([{
            "request_count": 1,
            "input_tokens": 10,
            "output_tokens": 20
        }])
    );

    execute_sql(
        &test_app.main_webview,
        "INSERT INTO message_parts (
             id, message_id, type, content, sort_order, created_at
         ) VALUES
             (9601, 9402, 'llm_call', '', 3, '2000-01-01 00:00:00'),
             (9602, 9402, 'llm_call', '', 4, '2999-01-01 00:00:00')",
        json!([]),
    );
    assert_eq!(
        database_operation(
            &test_app.main_webview,
            json!({ "kind": "usage_prune_detail", "retentionDays": 30 }),
        ),
        1
    );
    assert_eq!(
        query_sql(
            &test_app.main_webview,
            "SELECT id FROM message_parts
             WHERE type = 'llm_call' AND id IN (9601, 9602)
             ORDER BY id",
            json!([]),
        )["rows"],
        json!([{ "id": 9602 }])
    );

    let first = database_operation(
        &test_app.main_webview,
        json!({
            "kind": "usage_maintenance",
            "retentionDays": 30,
            "minIntervalMs": 900000,
            "now": "2026-11-05T10:00:00.000Z",
            "statisticKey": "usage_maintenance_run_at"
        }),
    );
    assert_eq!(first["ran"], true);
    assert_eq!(
        query_sql(
            &test_app.main_webview,
            "SELECT value FROM statistics WHERE key = ?",
            json!(["usage_maintenance_run_at"]),
        )["rows"],
        json!([{ "value": "2026-11-05T10:00:00.000Z" }])
    );
    let second = database_operation(
        &test_app.main_webview,
        json!({
            "kind": "usage_maintenance",
            "retentionDays": 30,
            "minIntervalMs": 900000,
            "now": "2026-11-05T10:01:00.000Z",
            "statisticKey": "usage_maintenance_run_at"
        }),
    );
    assert_eq!(second["ran"], false);
}
