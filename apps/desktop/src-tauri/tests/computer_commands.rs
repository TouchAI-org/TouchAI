mod common;

use common::{build_test_app, invoke_command_err, invoke_command_ok, TestAppOptions};
use serde_json::{json, Value};

fn foreground_target() -> serde_json::Value {
    json!({
        "scope": "foreground",
        "label": "Focused window"
    })
}

#[test]
fn computer_session_requires_non_empty_session_id_and_reports_capabilities() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let error = invoke_command_err(
        &test_app.main_webview,
        "built_in_tools_computer_session",
        json!({
            "request": {
                "sessionId": " ",
                "target": foreground_target(),
                "capabilities": ["native_tree", "screenshot", "background_actions"],
                "providerHints": [],
                "reason": "start desktop grounding",
                "timeoutMs": 8000
            }
        }),
    );
    assert_eq!(error, json!("sessionId cannot be empty"));

    let response: Value = invoke_command_ok(
        &test_app.main_webview,
        "built_in_tools_computer_session",
        json!({
            "request": {
                "sessionId": "session-call-1",
                "target": foreground_target(),
                "capabilities": ["native_tree", "screenshot", "background_actions"],
                "providerHints": [],
                "reason": "start desktop grounding",
                "timeoutMs": 8000
            }
        }),
    );

    assert_eq!(response["sessionId"], json!("session-call-1"));
    assert!(matches!(
        response["status"].as_str(),
        Some("ready" | "unsupported")
    ));
    assert!(response["capabilities"]["platform"].is_string());
    assert!(response["capabilities"]["lanes"].is_array());
    assert!(response["capabilities"]["routes"].is_array());
    assert_eq!(response["target"], foreground_target());
}

#[test]
fn computer_observe_returns_platform_and_requested_snapshot_shapes() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let _: Value = invoke_command_ok(
        &test_app.main_webview,
        "built_in_tools_computer_session",
        json!({
            "request": {
                "sessionId": "session-call-1",
                "target": foreground_target(),
                "capabilities": ["native_tree", "screenshot"],
                "providerHints": [],
                "reason": "start desktop grounding",
                "timeoutMs": 8000
            }
        }),
    );

    let response: Value = invoke_command_ok(
        &test_app.main_webview,
        "built_in_tools_computer_observe",
        json!({
            "request": {
                "sessionId": "session-call-1",
                "mode": "tree_and_screenshot",
                "target": foreground_target(),
                "include": ["displays", "windows", "tree", "screenshot"],
                "reason": "ground next action",
                "timeoutMs": 8000
            }
        }),
    );

    assert!(response["observationId"]
        .as_str()
        .is_some_and(|id| id.starts_with("obs-")));
    assert_eq!(response["sessionId"], json!("session-call-1"));
    assert!(response["platform"].is_string());
    assert!(response["displays"].is_array());
    assert!(response["windows"].is_array());
    assert!(response["warnings"].is_array());
    assert!(response.get("tree").is_some());
    assert!(response.get("screenshot").is_some());
}

#[test]
fn computer_act_dry_run_returns_stable_receipt() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let _: Value = invoke_command_ok(
        &test_app.main_webview,
        "built_in_tools_computer_session",
        json!({
            "request": {
                "sessionId": "session-call-1",
                "target": foreground_target(),
                "capabilities": ["native_tree", "screenshot"],
                "providerHints": [],
                "reason": "start desktop grounding",
                "timeoutMs": 8000
            }
        }),
    );

    let response: Value = invoke_command_ok(
        &test_app.main_webview,
        "built_in_tools_computer_act",
        json!({
            "request": {
                "sessionId": "session-call-1",
                "operation": "click",
                "target": {
                    "scope": "screen",
                    "x": 120,
                    "y": 130
                },
                "value": null,
                "executionMode": "foreground",
                "reason": "validate click routing",
                "routeHint": "auto",
                "timeoutMs": 8000,
                "options": {
                    "allowBackground": false,
                    "dryRun": true,
                    "postActionObserve": false
                }
            }
        }),
    );

    assert!(response["actionId"]
        .as_str()
        .is_some_and(|id| id.starts_with("act-")));
    assert_eq!(response["sessionId"], json!("session-call-1"));
    assert_eq!(response["operation"], json!("click"));
    assert_eq!(response["route"], json!("win32.send_input"));
    assert_eq!(response["lane"], json!("vision_fallback"));
    assert_eq!(response["backgroundSafe"], json!(false));
    assert_eq!(response["cursorMoved"], json!(false));
    assert_eq!(response["foregroundChanged"], json!(false));
    assert_eq!(response["targetResolved"]["x"], json!(120));
    assert_eq!(response["targetResolved"]["y"], json!(130));
    assert_eq!(response["status"], json!("success"));
}

#[test]
fn computer_act_rejects_invalid_route_and_background_coordinate_actions() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let _: Value = invoke_command_ok(
        &test_app.main_webview,
        "built_in_tools_computer_session",
        json!({
            "request": {
                "sessionId": "session-call-1",
                "target": foreground_target(),
                "capabilities": ["native_tree", "screenshot", "background_actions"],
                "providerHints": [],
                "reason": "start desktop grounding",
                "timeoutMs": 8000
            }
        }),
    );

    let invalid_route: Value = invoke_command_ok(
        &test_app.main_webview,
        "built_in_tools_computer_act",
        json!({
            "request": {
                "sessionId": "session-call-1",
                "operation": "click",
                "target": { "elementId": "window:100" },
                "value": null,
                "executionMode": "foreground",
                "reason": "bad route",
                "routeHint": "screen.capture",
                "timeoutMs": 8000,
                "options": {
                    "allowBackground": false,
                    "dryRun": true,
                    "postActionObserve": false
                }
            }
        }),
    );
    assert_eq!(invalid_route["route"], json!("screen.capture"));
    assert_eq!(invalid_route["status"], json!("blocked"));
    assert_eq!(
        invalid_route["warnings"],
        json!(["route 'screen.capture' cannot execute computer actions"])
    );

    let background_coordinate: Value = invoke_command_ok(
        &test_app.main_webview,
        "built_in_tools_computer_act",
        json!({
            "request": {
                "sessionId": "session-call-1",
                "operation": "click",
                "target": {
                    "scope": "screen",
                    "x": 120,
                    "y": 130
                },
                "value": null,
                "executionMode": "background",
                "reason": "unsafe background coordinate",
                "routeHint": "auto",
                "timeoutMs": 8000,
                "options": {
                    "allowBackground": true,
                    "dryRun": true,
                    "postActionObserve": false
                }
            }
        }),
    );
    assert_eq!(background_coordinate["route"], json!("win32.message"));
    assert_eq!(background_coordinate["status"], json!("blocked"));
    assert_eq!(
        background_coordinate["warnings"],
        json!(["coordinate targets cannot be executed in background mode"])
    );
}
