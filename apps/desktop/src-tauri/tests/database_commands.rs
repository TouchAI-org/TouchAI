mod common;

use common::{build_test_app, invoke_command_err, invoke_command_ok, TestAppOptions};
use serde_json::json;

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
