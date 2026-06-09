mod common;

use common::{build_test_app, invoke_command_ok, TestAppOptions};
use serde_json::{json, Value};
use std::{path::Path, sync::Mutex};
use tempfile::TempDir;
use touchai_lib::testing;

static APP_USE_OWNED_ENV_LOCK: Mutex<()> = Mutex::new(());

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

fn prepare_owned_wps_test_root() -> TempDir {
    let root = TempDir::new().expect("owned WPS temp root");
    testing::configure_app_use_wps_owned_root_for_tests(root.path()).expect("owned WPS root");
    root
}

fn write_owned_wps_test_file(path: &Path, app_label: &str) {
    std::fs::create_dir_all(path.parent().expect("owned file parent")).expect("owned root");
    std::fs::write(path, b"owned").expect("owned file");
    testing::mark_app_use_wps_owned_target_for_tests(path, app_label).expect("owned marker");
}

fn remove_owned_wps_test_file(path: &Path) {
    let _ = std::fs::remove_file(path);
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
fn app_use_session_create_owned_target_returns_signed_target() {
    let _guard = APP_USE_OWNED_ENV_LOCK
        .lock()
        .expect("app use owned env lock");
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");
    let owned_root = prepare_owned_wps_test_root();

    let response: Value = invoke_command_ok(
        &test_app.main_webview,
        "app_use_session",
        json!({
            "request": {
                "executionId": "app-use-create-target-1",
                "operation": "create_owned_target",
                "description": "create an owned WPS spreadsheet target",
                "adapterId": "wps_spreadsheet",
                "targetKind": "spreadsheet",
                "config": {
                    "mode": "interactive",
                    "adapters": {
                        "office_word": false,
                        "office_excel": false,
                        "office_powerpoint": false,
                        "wps_writer": false,
                        "wps_spreadsheet": true,
                        "wps_presentation": false,
                        "photoshop": false,
                        "illustrator": false
                    },
                    "mutatingApprovalMode": "always",
                    "readScope": "active",
                    "allowRawAutomation": false,
                    "timeoutMs": 15000,
                    "maxOutputChars": 12000
                }
            }
        }),
    );

    assert_eq!(response["ok"], true);
    assert_eq!(response["adapterId"], "wps_spreadsheet");
    assert_eq!(response["targetKind"], "spreadsheet");
    let target = response["target"].as_str().expect("target path");
    assert!(target.ends_with(".xlsx"));
    let canonical_owned_root = owned_root
        .path()
        .canonicalize()
        .expect("canonical owned root");
    assert!(
        Path::new(target).starts_with(&canonical_owned_root),
        "target {target} should live under {}",
        canonical_owned_root.display()
    );
    let marker_path = Path::new(target).with_file_name(format!(
        "{}.touchai-owned.json",
        Path::new(target)
            .file_name()
            .and_then(|value| value.to_str())
            .expect("target filename")
    ));
    let marker = std::fs::read_to_string(&marker_path).expect("owned marker");
    assert!(marker.contains("\"signature\""));
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
                "action": "replace_document_text",
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
                "action": "replace_document_text",
                "description": "direct native call should not mutate",
                "parameters": { "text": "hello" },
                "approval": {
                    "callId": "app-use-test-4",
                    "adapterId": "office_word",
                    "action": "replace_document_text",
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
                "action": "replace_document_text",
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
    let _guard = APP_USE_OWNED_ENV_LOCK
        .lock()
        .expect("app use owned env lock");
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");
    let owned_root = prepare_owned_wps_test_root();
    let target_path = owned_root.path().join("command-insert-text-owned.docx");
    write_owned_wps_test_file(&target_path, "WPS Writer");

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
