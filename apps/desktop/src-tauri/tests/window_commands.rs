mod common;

use common::{build_test_app, invoke_command_err, invoke_command_ok, TestAppOptions};
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

/// A waiting-approval reminder carries the identity of the pending decision so the native
/// action can be matched back to it later. These tests drive the command the renderer calls
/// and read the record the native layer keeps, so they assert the payload that survives the
/// IPC decoder, not the wrapper that forwards it.
#[test]
fn user_sees_the_approval_decision_identity_kept_when_a_waiting_reminder_is_shown() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let response: () = invoke_command_ok(
        &test_app.main_webview,
        "show_session_status_reminder_notification",
        json!({
            "payload": {
                "title": "TouchAI",
                "body": "A tool call needs approval",
                "sessionId": 12,
                "taskId": "task-12",
                "kind": "waiting_approval",
                "approval": {
                    "callId": "call-7",
                    "approveLabel": "Approve",
                    "rejectLabel": "Reject",
                    "decisionId": "task-12:1:call-7:1"
                }
            }
        }),
    );

    assert_eq!(response, ());
    let records = testing::session_status_reminder_notifications(&test_app.app);
    assert_eq!(records.len(), 1);
    let approval = records[0]
        .approval
        .as_ref()
        .expect("waiting reminder keeps its approval payload");
    assert_eq!(approval.call_id, "call-7");
    assert_eq!(approval.decision_id.as_deref(), Some("task-12:1:call-7:1"));
}

#[test]
fn user_sees_a_waiting_reminder_shown_when_the_approval_omits_the_decision_identity() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let response: () = invoke_command_ok(
        &test_app.main_webview,
        "show_session_status_reminder_notification",
        json!({
            "payload": {
                "title": "TouchAI",
                "body": "A tool call needs approval",
                "sessionId": 4,
                "taskId": "task-4",
                "kind": "waiting_approval",
                "approval": {
                    "callId": "call-1",
                    "approveLabel": "Approve",
                    "rejectLabel": "Reject"
                }
            }
        }),
    );

    assert_eq!(response, ());
    let records = testing::session_status_reminder_notifications(&test_app.app);
    assert_eq!(records.len(), 1);
    let approval = records[0].approval.as_ref().expect("approval payload");
    assert_eq!(approval.call_id, "call-1");
    assert!(approval.decision_id.is_none());
}

#[test]
fn user_sees_a_reminder_rejected_when_a_required_field_is_missing() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    invoke_command_err(
        &test_app.main_webview,
        "show_session_status_reminder_notification",
        json!({
            "payload": {
                "body": "Task completed",
                "sessionId": 1,
                "taskId": "task-1",
                "kind": "completed"
            }
        }),
    );

    assert!(testing::session_status_reminder_notifications(&test_app.app).is_empty());
}

#[test]
fn user_sees_a_reminder_rejected_when_a_required_field_has_the_wrong_type() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    invoke_command_err(
        &test_app.main_webview,
        "show_session_status_reminder_notification",
        json!({
            "payload": {
                "title": "TouchAI",
                "body": "Task completed",
                "sessionId": "not-a-number",
                "taskId": "task-1",
                "kind": "completed"
            }
        }),
    );

    assert!(testing::session_status_reminder_notifications(&test_app.app).is_empty());
}
