mod common;

use std::sync::{Arc, Mutex};

use common::{build_test_app, invoke_command_err, invoke_command_ok, TestAppOptions};
use serde_json::json;
use tauri::Listener;
use touchai_lib::testing;

#[test]
fn set_tray_status_indicator_updates_runtime_state() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let response: () = invoke_command_ok(
        &test_app.main_webview,
        "set_tray_status_indicator",
        json!({ "status": "failed" }),
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
        json!({ "status": "waiting_approval" }),
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
            "defaults": { "width": 750.0, "height": 60.0 },
            "currentWidth": 750.0,
            "currentHeight": 60.0,
            "heightMode": "auto",
            "hostContentHeight": null,
            "monitorHost": cfg!(target_os = "windows")
        })
    );
}

#[test]
fn set_search_window_defaults_clamps_and_updates_runtime_state() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let response: serde_json::Value = invoke_command_ok(
        &test_app.main_webview,
        "set_search_window_defaults",
        json!({ "defaults": { "width": 320.0, "height": 40.0 } }),
    );

    assert_eq!(response, json!({ "width": 420.0, "height": 60.0 }));

    let state: serde_json::Value =
        invoke_command_ok(&test_app.main_webview, "get_search_window_state", json!({}));
    assert_eq!(
        state,
        json!({
            "defaults": { "width": 420.0, "height": 60.0 },
            "currentWidth": 420.0,
            "currentHeight": 60.0,
            "heightMode": "auto",
            "hostContentHeight": null,
            "monitorHost": cfg!(target_os = "windows")
        })
    );
}

#[test]
fn set_search_surface_hide_on_app_blur_updates_runtime_policy() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let response: () = invoke_command_ok(
        &test_app.main_webview,
        "set_search_surface_hide_on_app_blur",
        json!({ "shouldHide": false }),
    );

    assert_eq!(response, ());
    assert!(!testing::search_surface_policies(&test_app.app).hide_on_app_blur);
}

#[test]
fn set_search_window_allow_height_override_updates_runtime_policy() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let response: () = invoke_command_ok(
        &test_app.main_webview,
        "set_search_window_allow_height_override",
        json!({ "allow": true }),
    );

    assert_eq!(response, ());
    assert!(testing::search_surface_policies(&test_app.app).allow_height_override);
}

#[test]
fn commit_search_panel_resize_classifies_width_and_height_from_frontend_geometry() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");
    let _: () = invoke_command_ok(
        &test_app.main_webview,
        "set_search_window_allow_height_override",
        json!({ "allow": true }),
    );

    let width_only: serde_json::Value = invoke_command_ok(
        &test_app.main_webview,
        "commit_search_panel_resize",
        json!({
            "resize": {
                "from": { "width": 750.0, "height": 300.0 },
                "to": { "width": 900.0, "height": 300.0 }
            }
        }),
    );
    assert_eq!(width_only["currentWidth"], 900.0);
    assert_eq!(width_only["currentHeight"], 300.0);
    assert_eq!(width_only["heightMode"], "auto");

    let height_change: serde_json::Value = invoke_command_ok(
        &test_app.main_webview,
        "commit_search_panel_resize",
        json!({
            "resize": {
                "from": { "width": 900.0, "height": 300.0 },
                "to": { "width": 900.0, "height": 420.0 }
            }
        }),
    );
    assert_eq!(height_change["currentHeight"], 420.0);
    assert_eq!(height_change["heightMode"], "manual_override");
}

#[test]
fn commit_search_panel_resize_auto_keeps_content_height_in_auto_mode() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");
    let _: () = invoke_command_ok(
        &test_app.main_webview,
        "set_search_window_allow_height_override",
        json!({ "allow": true }),
    );

    let response: serde_json::Value = invoke_command_ok(
        &test_app.main_webview,
        "commit_search_panel_resize",
        json!({
            "resize": {
                "from": { "width": 750.0, "height": 60.0 },
                "to": { "width": 750.0, "height": 210.0 },
                "auto": true
            }
        }),
    );

    assert_eq!(response["currentWidth"], 750.0);
    assert_eq!(response["currentHeight"], 210.0);
    assert_eq!(response["heightMode"], "auto");
    assert_eq!(response["hostContentHeight"], serde_json::Value::Null);
}

#[test]
fn commit_search_panel_resize_returns_retained_host_content_height() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let response: serde_json::Value = invoke_command_ok(
        &test_app.main_webview,
        "commit_search_panel_resize",
        json!({
            "resize": {
                "from": { "width": 750.0, "height": 60.0 },
                "to": { "width": 750.0, "height": 60.0 },
                "hostContentHeight": 373.0,
                "auto": true
            }
        }),
    );

    assert_eq!(response["hostContentHeight"], 373.0);

    let state: serde_json::Value =
        invoke_command_ok(&test_app.main_webview, "get_search_window_state", json!({}));
    assert_eq!(state["hostContentHeight"], 373.0);
}

#[test]
fn commit_search_panel_resize_rejects_invalid_geometry_without_mutating_state() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let error = invoke_command_err(
        &test_app.main_webview,
        "commit_search_panel_resize",
        json!({
            "resize": {
                "from": { "width": 750.0, "height": 60.0 },
                "to": { "width": -1.0, "height": 420.0 }
            }
        }),
    );
    assert!(error
        .as_str()
        .is_some_and(|message| message.contains("positive finite")));

    let state: serde_json::Value =
        invoke_command_ok(&test_app.main_webview, "get_search_window_state", json!({}));
    assert_eq!(state["currentWidth"], 750.0);
    assert_eq!(state["currentHeight"], 60.0);
    assert_eq!(state["heightMode"], "auto");
}

fn current_renderer_epoch(test_app: &common::TestApp) -> u64 {
    invoke_command_ok(
        &test_app.main_webview,
        "get_search_window_renderer_epoch",
        json!({}),
    )
}

fn request_pending_preparation(test_app: &common::TestApp) -> serde_json::Value {
    let _: () = invoke_command_ok(&test_app.main_webview, "show_search_window", json!({}));
    invoke_command_ok(
        &test_app.main_webview,
        "mark_search_window_ready",
        json!({ "rendererEpoch": current_renderer_epoch(test_app) }),
    )
}

fn preparation_token(preparation: &serde_json::Value) -> serde_json::Value {
    json!({
        "rendererEpoch": preparation["rendererEpoch"],
        "showEpoch": preparation["showEpoch"],
        "hostEpoch": preparation["hostEpoch"],
    })
}

fn region_payload(generation: u64, preparation: Option<serde_json::Value>) -> serde_json::Value {
    let mut payload = json!({
        "generation": generation,
        "regions": [
            { "x": 48.0, "y": 48.0, "width": 750.0, "height": 60.0, "cornerRadius": 8.0 }
        ],
    });
    if let Some(preparation) = preparation {
        payload["preparation"] = preparation;
    }
    payload
}

#[test]
fn hidden_main_mark_ready_without_a_show_intent_remains_protocol_hidden() {
    let test_app = build_test_app(TestAppOptions::default()).expect("hidden test app");

    let response: serde_json::Value = invoke_command_ok(
        &test_app.main_webview,
        "mark_search_window_ready",
        json!({ "rendererEpoch": current_renderer_epoch(&test_app) }),
    );

    assert_eq!(response, serde_json::Value::Null);
    let snapshot = testing::search_surface_protocol(&test_app.app);
    assert!(snapshot.renderer_ready);
    assert!(!snapshot.desired_visible);
    assert_eq!(snapshot.phase, "hidden");
    assert!(snapshot.last_shown.is_none());
}

#[test]
fn untokenized_or_wrong_token_regions_cannot_unlock_a_pending_show() {
    let test_app = build_test_app(TestAppOptions::default()).expect("hidden test app");
    let preparation = request_pending_preparation(&test_app);
    assert_eq!(
        testing::search_surface_protocol(&test_app.app).phase,
        "preparing"
    );

    let untokenized: serde_json::Value = invoke_command_ok(
        &test_app.main_webview,
        "set_search_window_regions",
        region_payload(1, None),
    );
    let mut wrong = preparation_token(&preparation);
    wrong["hostEpoch"] = json!(preparation["hostEpoch"].as_u64().unwrap() + 1);
    let wrong_token: serde_json::Value = invoke_command_ok(
        &test_app.main_webview,
        "set_search_window_regions",
        region_payload(2, Some(wrong)),
    );

    assert_eq!(untokenized, json!({ "status": "applied", "generation": 1 }));
    assert_eq!(wrong_token, json!({ "status": "applied", "generation": 2 }));
    let snapshot = testing::search_surface_protocol(&test_app.app);
    assert_eq!(snapshot.phase, "preparing");
    assert!(snapshot.last_shown.is_none());
}

#[test]
fn matching_final_region_token_commits_show_and_emits_causal_facts_once() {
    let test_app = build_test_app(TestAppOptions::default()).expect("hidden test app");
    let events = Arc::new(Mutex::new(Vec::<(&'static str, serde_json::Value)>::new()));
    for name in ["search-surface-prepare", "search-surface-shown"] {
        let sink = Arc::clone(&events);
        test_app.app.listen_any(name, move |event| {
            sink.lock().unwrap().push((
                name,
                serde_json::from_str(event.payload()).expect("event JSON"),
            ));
        });
    }

    let preparation = request_pending_preparation(&test_app);
    assert_eq!(
        events.lock().unwrap().as_slice(),
        &[("search-surface-prepare", preparation.clone())]
    );

    let response: serde_json::Value = invoke_command_ok(
        &test_app.main_webview,
        "set_search_window_regions",
        region_payload(7, Some(preparation_token(&preparation))),
    );

    assert_eq!(response["status"], "applied");
    assert_eq!(response["generation"], 7);
    assert_eq!(response["showStatus"]["status"], "shown");
    assert_eq!(
        response["showStatus"]["rendererEpoch"],
        preparation["rendererEpoch"]
    );
    assert_eq!(
        response["showStatus"]["showEpoch"],
        preparation["showEpoch"]
    );
    assert_eq!(
        response["showStatus"]["hostEpoch"],
        preparation["hostEpoch"]
    );
    assert_eq!(response["showStatus"]["generation"], 7);

    let captured = events.lock().unwrap();
    assert_eq!(captured.len(), 2);
    assert_eq!(captured[1].0, "search-surface-shown");
    let shown = &captured[1].1;
    assert_eq!(shown["source"], preparation["source"]);
    assert!(shown["sequence"]
        .as_u64()
        .is_some_and(|sequence| sequence > 0));
    assert_eq!(shown["rendererEpoch"], preparation["rendererEpoch"]);
    assert_eq!(shown["showEpoch"], preparation["showEpoch"]);
    assert_eq!(shown["hostEpoch"], preparation["hostEpoch"]);
    assert_eq!(shown["generation"], 7);
    drop(captured);

    let snapshot = testing::search_surface_protocol(&test_app.app);
    assert_eq!(snapshot.phase, "visible");
    assert_eq!(snapshot.last_shown.unwrap().region_generation, 7);
}

#[test]
fn hide_invalidates_a_pending_preparation_before_a_late_region_ack() {
    let test_app = build_test_app(TestAppOptions::default()).expect("hidden test app");
    let preparation = request_pending_preparation(&test_app);
    let _: () = invoke_command_ok(&test_app.main_webview, "hide_search_window", json!({}));

    let response: serde_json::Value = invoke_command_ok(
        &test_app.main_webview,
        "set_search_window_regions",
        region_payload(1, Some(preparation_token(&preparation))),
    );

    assert_eq!(response, json!({ "status": "applied", "generation": 1 }));
    let snapshot = testing::search_surface_protocol(&test_app.app);
    assert_eq!(snapshot.phase, "hidden");
    assert!(!snapshot.desired_visible);
    assert!(snapshot.last_shown.is_none());
}
