mod common;

use common::{build_test_app, invoke_command_ok, TestAppOptions};
use serde_json::{json, Value};

fn app_use_config() -> Value {
    json!({
        "mode": "read_only",
        "adapters": {
            "office_word": false,
            "office_excel": false,
            "office_powerpoint": false,
            "wps_writer": false,
            "wps_spreadsheet": false,
            "wps_presentation": false,
            "photoshop": false,
            "illustrator": false
        },
        "mutatingApprovalMode": "always",
        "readScope": "active",
        "allowBackgroundOperation": false,
        "allowRawAutomation": false,
        "timeoutMs": 15000,
        "maxOutputChars": 12000
    })
}

fn interactive_office_config() -> Value {
    let mut config = app_use_config();
    config["mode"] = json!("interactive");
    config["adapters"]["office_word"] = json!(true);
    config
}

#[test]
fn app_use_session_reports_first_batch_adapters() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let response: Value = invoke_command_ok(
        &test_app.main_webview,
        "app_use_session",
        json!({
            "request": {
                "executionId": "app-use-test-1",
                "operation": "discover",
                "description": "discover supported applications",
                "config": app_use_config()
            }
        }),
    );

    assert_eq!(response["ok"], true);
    assert_eq!(response["operation"], "discover");
    let adapters = response["adapters"].as_array().expect("adapter list");
    assert_eq!(adapters.len(), 8);
    assert!(adapters.iter().any(|adapter| adapter["id"] == "wps_writer"));
}

#[test]
fn app_use_observe_rejects_disabled_adapter() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let response: Value = invoke_command_ok(
        &test_app.main_webview,
        "app_use_observe",
        json!({
            "request": {
                "executionId": "app-use-test-2",
                "adapterId": "wps_writer",
                "scope": "selection",
                "description": "read current selection",
                "maxOutputChars": 12000,
                "config": app_use_config()
            }
        }),
    );

    assert_eq!(response["ok"], false);
    assert_eq!(response["adapterId"], "wps_writer");
    assert_eq!(response["scope"], "selection");
    assert!(response["content"]
        .as_str()
        .expect("error content")
        .contains("disabled"));
}

#[test]
fn app_use_act_rejects_read_only_mode() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let response: Value = invoke_command_ok(
        &test_app.main_webview,
        "app_use_act",
        json!({
            "request": {
                "executionId": "app-use-test-3",
                "adapterId": "wps_writer",
                "action": "replace_selection",
                "description": "replace current selection",
                "parameters": { "text": "hello" },
                "config": app_use_config()
            }
        }),
    );

    assert_eq!(response["ok"], false);
    assert_eq!(response["changed"], false);
    assert!(response["receipt"]
        .as_str()
        .expect("receipt")
        .contains("read-only"));
}

#[test]
fn app_use_act_rejects_direct_native_call_without_approval() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let response: Value = invoke_command_ok(
        &test_app.main_webview,
        "app_use_act",
        json!({
            "request": {
                "executionId": "app-use-test-4",
                "adapterId": "office_word",
                "action": "replace_selection",
                "description": "direct native call should not mutate",
                "parameters": { "text": "hello" },
                "approval": {
                    "callId": "app-use-test-4",
                    "adapterId": "office_word",
                    "action": "replace_selection",
                    "approved": true
                },
                "config": interactive_office_config()
            }
        }),
    );

    assert_eq!(response["ok"], false);
    assert_eq!(response["changed"], false);
    assert_eq!(response["metadata"]["reason"], "approval_required");
}

#[test]
fn app_use_act_consumes_native_authorization_permit_once() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let authorization: Value = invoke_command_ok(
        &test_app.main_webview,
        "app_use_authorize_act",
        json!({
            "request": {
                "executionId": "app-use-test-5",
                "adapterId": "office_word",
                "action": "replace_selection",
                "targetId": "target-1",
                "parameters": { "text": "hello" },
                "config": interactive_office_config()
            }
        }),
    );
    let permit = authorization["permit"].clone();
    assert!(permit["token"]
        .as_str()
        .is_some_and(|token| !token.is_empty()));

    let first_response: Value = invoke_command_ok(
        &test_app.main_webview,
        "app_use_act",
        json!({
            "request": {
                "executionId": "app-use-test-5",
                "adapterId": "office_word",
                "action": "replace_selection",
                "description": "authorized native call reaches adapter",
                "targetId": "target-1",
                "parameters": { "text": "hello" },
                "permit": permit.clone(),
                "config": interactive_office_config()
            }
        }),
    );
    assert_eq!(first_response["ok"], false);
    assert_eq!(
        first_response["metadata"]["reason"],
        "adapter_unimplemented"
    );

    let replay_response: Value = invoke_command_ok(
        &test_app.main_webview,
        "app_use_act",
        json!({
            "request": {
                "executionId": "app-use-test-5",
                "adapterId": "office_word",
                "action": "replace_selection",
                "description": "replay should not mutate",
                "targetId": "target-1",
                "parameters": { "text": "hello" },
                "permit": permit,
                "config": interactive_office_config()
            }
        }),
    );
    assert_eq!(replay_response["ok"], false);
    assert_eq!(replay_response["metadata"]["reason"], "approval_required");
}
