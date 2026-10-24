mod common;

use common::{build_test_app, invoke_command_err, invoke_command_ok, TestAppOptions};
use serde_json::json;

/// The renderer asks the backend where each app-owned directory lives instead of guessing
/// from the platform. These tests drive that command the way the renderer does, so the
/// contract that matters is the one over IPC: which keys are accepted, what the resolved
/// paths look like, and what an unknown key reports.
#[test]
fn user_gets_a_resolved_path_for_every_supported_directory() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    for key in [
        "DATA",
        "LOGS",
        "CACHE",
        "CACHE_ICONS",
        "ASSETS",
        "ASSETS_FONT",
        "ASSETS_BIN",
    ] {
        let path: String = invoke_command_ok(
            &test_app.main_webview,
            "get_app_directory_path",
            json!({ "directory": key }),
        );

        assert!(!path.is_empty(), "{key} resolved to an empty path");
    }
}

#[test]
fn user_gets_the_same_directory_regardless_of_key_casing_or_padding() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let exact: String = invoke_command_ok(
        &test_app.main_webview,
        "get_app_directory_path",
        json!({ "directory": "CACHE_ICONS" }),
    );
    let messy: String = invoke_command_ok(
        &test_app.main_webview,
        "get_app_directory_path",
        json!({ "directory": "  cache_icons  " }),
    );

    assert_eq!(exact, messy);
}

#[test]
fn user_gets_an_error_naming_the_supported_keys_for_an_unknown_directory() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let error = invoke_command_err(
        &test_app.main_webview,
        "get_app_directory_path",
        json!({ "directory": "NOT_A_DIRECTORY" }),
    )
    .to_string();

    assert!(
        error.contains("Unsupported app directory"),
        "error did not explain the rejection: {error}"
    );
    // The message has to list what is accepted, otherwise the renderer cannot recover.
    assert!(
        error.contains("DATA"),
        "error did not list the supported keys: {error}"
    );
}

#[test]
fn user_gets_distinct_paths_for_distinct_directories() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let data: String = invoke_command_ok(
        &test_app.main_webview,
        "get_app_directory_path",
        json!({ "directory": "DATA" }),
    );
    let logs: String = invoke_command_ok(
        &test_app.main_webview,
        "get_app_directory_path",
        json!({ "directory": "LOGS" }),
    );

    assert_ne!(data, logs);
}

#[test]
fn user_gets_the_runtime_info_of_the_running_build() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let info: serde_json::Value =
        invoke_command_ok(&test_app.main_webview, "get_runtime_info", json!({}));

    // The renderer reads this flag to decide whether to expose test-only affordances.
    assert!(
        info.get("isE2eTestMode").is_some(),
        "runtime info was missing isE2eTestMode: {info}"
    );
}
