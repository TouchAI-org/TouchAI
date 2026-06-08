mod common;

use common::{build_test_app, invoke_command_ok, TestAppOptions};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

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

fn owned_marker_path(target_path: &Path) -> PathBuf {
    let mut marker_name = target_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("target")
        .to_string();
    marker_name.push_str(".touchai-owned.json");
    target_path.with_file_name(marker_name)
}

fn hash_owned_path(target_path: &Path) -> String {
    let canonical = target_path.to_string_lossy().to_ascii_lowercase();
    let mut hasher = Sha256::new();
    hasher.update(canonical.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn write_owned_wps_test_file(path: &Path) {
    std::fs::create_dir_all(path.parent().expect("owned file parent")).expect("owned root");
    std::fs::write(path, b"owned").expect("owned file");
    let canonical_path = path.canonicalize().expect("canonical owned file");
    let marker = json!({
        "createdBy": "TouchAI App Use command test",
        "pathHash": hash_owned_path(&canonical_path),
    });
    std::fs::write(owned_marker_path(&canonical_path), marker.to_string()).expect("owned marker");
}

fn remove_owned_wps_test_file(path: &Path) {
    let marker = path
        .canonicalize()
        .ok()
        .map(|canonical_path| owned_marker_path(&canonical_path));
    let _ = std::fs::remove_file(path);
    if let Some(marker) = marker {
        let _ = std::fs::remove_file(marker);
    }
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
fn app_use_authorize_act_refuses_unimplemented_adapter() {
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

    assert_eq!(authorization["permit"], Value::Null);
    assert_eq!(authorization["expiresInMs"], 0);
}

#[test]
fn app_use_authorize_act_refuses_unimplemented_writer_insert_text() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");
    let target_path = std::env::temp_dir()
        .join("touchai-wps-smoke")
        .join("command-insert-text-owned.docx");
    write_owned_wps_test_file(&target_path);

    let authorization: Value = invoke_command_ok(
        &test_app.main_webview,
        "app_use_authorize_act",
        json!({
            "request": {
                "executionId": "app-use-test-6",
                "adapterId": "wps_writer",
                "action": "insert_text",
                "targetId": target_path.to_string_lossy(),
                "parameters": { "text": "hello" },
                "config": {
                    "mode": "interactive",
                    "adapters": {
                        "office_word": false,
                        "office_excel": false,
                        "office_powerpoint": false,
                        "wps_writer": true,
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
                }
            }
        }),
    );

    assert_eq!(authorization["permit"], Value::Null);
    assert_eq!(authorization["expiresInMs"], 0);
    remove_owned_wps_test_file(&target_path);
}
