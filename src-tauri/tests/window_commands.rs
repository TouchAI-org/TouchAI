mod common;

use common::{build_test_app, invoke_command_ok, invoke_command_result, TestAppOptions};
use serde_json::json;
use touchai_lib::testing;

#[test]
fn register_popup_configs_persists_popup_registry_entries() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let response: () = invoke_command_ok(
        &test_app.main_webview,
        "register_popup_configs",
        json!({
            "configs": [
                {
                    "id": "session-history-popup",
                    "width": 320.0,
                    "height": 384.0
                }
            ]
        }),
    );

    assert_eq!(response, ());
    assert!(testing::popup_registry_has(
        &test_app.app,
        "session-history-popup"
    ));
}

#[test]
fn set_tray_status_indicator_updates_runtime_state() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let response: () = invoke_command_ok(
        &test_app.main_webview,
        "set_tray_status_indicator",
        json!({
            "status": "failed"
        }),
    );

    assert_eq!(response, ());
    assert_eq!(
        testing::tray_status_indicator(&test_app.app).as_deref(),
        Some("failed")
    );
}

#[test]
fn clear_tray_status_indicator_resets_runtime_state() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let _: () = invoke_command_ok(
        &test_app.main_webview,
        "set_tray_status_indicator",
        json!({
            "status": "waiting_approval"
        }),
    );
    let response: () = invoke_command_ok(
        &test_app.main_webview,
        "clear_tray_status_indicator",
        json!({}),
    );

    assert_eq!(response, ());
    assert_eq!(testing::tray_status_indicator(&test_app.app), None);
}

#[test]
fn show_session_status_reminder_notification_records_test_runtime_entry() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let response: () = invoke_command_ok(
        &test_app.main_webview,
        "show_session_status_reminder_notification",
        json!({
            "payload": {
                "title": "TouchAI",
                "body": "Task completed",
                "sessionId": 5,
                "taskId": "task-1",
                "kind": "completed",
                "approval": null
            }
        }),
    );

    assert_eq!(response, ());
    let records = testing::session_status_reminder_notifications(&test_app.app);
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].title, "TouchAI");
    assert_eq!(records[0].body, "Task completed");
    assert_eq!(records[0].session_id, 5);
    assert_eq!(records[0].task_id, "task-1");
}

#[test]
fn clear_session_status_reminder_notifications_updates_runtime_state() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let _: () = invoke_command_ok(
        &test_app.main_webview,
        "show_session_status_reminder_notification",
        json!({
            "payload": {
                "title": "TouchAI",
                "body": "Task failed",
                "sessionId": 7,
                "taskId": "task-2",
                "kind": "failed",
                "approval": null
            }
        }),
    );

    let response: () = invoke_command_ok(
        &test_app.main_webview,
        "clear_session_status_reminder_notifications",
        json!({}),
    );

    assert_eq!(response, ());
    assert_eq!(
        testing::session_status_reminder_clear_count(&test_app.app),
        1
    );
}

#[test]
fn show_search_window_command_is_registered() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let response = invoke_command_result(&test_app.main_webview, "show_search_window", json!({}));

    if cfg!(target_os = "windows") {
        let error =
            response.expect_err("windows mock runtime should not complete real webview focus");
        assert!(
            error
                .as_str()
                .is_some_and(|message| message.contains("focus result")),
            "unexpected show_search_window error: {error}"
        );
    } else {
        assert!(response.is_ok());
    }
}

#[test]
fn get_search_window_state_returns_default_snapshot() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let state: serde_json::Value =
        invoke_command_ok(&test_app.main_webview, "get_search_window_state", json!({}));

    assert_eq!(
        state,
        json!({
            "defaults": {
                "width": 750.0,
                "height": 60.0
            },
            "currentWidth": 750.0,
            "currentHeight": 60.0,
            "heightMode": "auto"
        })
    );
}

#[test]
fn set_search_window_defaults_clamps_and_updates_runtime_state() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let response: serde_json::Value = invoke_command_ok(
        &test_app.main_webview,
        "set_search_window_defaults",
        json!({
            "defaults": {
                "width": 320.0,
                "height": 40.0
            }
        }),
    );

    assert_eq!(
        response,
        json!({
            "width": 420.0,
            "height": 60.0
        })
    );

    let state: serde_json::Value =
        invoke_command_ok(&test_app.main_webview, "get_search_window_state", json!({}));

    assert_eq!(
        state,
        json!({
            "defaults": {
                "width": 420.0,
                "height": 60.0
            },
            "currentWidth": 420.0,
            "currentHeight": 60.0,
            "heightMode": "auto"
        })
    );
}

#[test]
fn set_search_surface_hide_on_app_blur_updates_runtime_policy() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let response: () = invoke_command_ok(
        &test_app.main_webview,
        "set_search_surface_hide_on_app_blur",
        json!({
            "shouldHide": false
        }),
    );

    assert_eq!(response, ());
    let policies = testing::search_surface_policies(&test_app.app);
    assert!(!policies.hide_on_app_blur);
}

#[test]
fn set_search_window_allow_height_override_updates_runtime_policy() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let response: () = invoke_command_ok(
        &test_app.main_webview,
        "set_search_window_allow_height_override",
        json!({
            "allow": true
        }),
    );

    assert_eq!(response, ());
    let policies = testing::search_surface_policies(&test_app.app);
    assert!(policies.allow_height_override);
}
