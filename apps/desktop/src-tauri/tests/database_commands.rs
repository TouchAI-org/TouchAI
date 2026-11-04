mod common;

use common::{build_test_app, invoke_command_err, invoke_command_ok, TestAppOptions};
use serde_json::json;
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
