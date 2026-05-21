mod common;

use common::{build_test_app, invoke_command_ok, TestAppOptions};
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
