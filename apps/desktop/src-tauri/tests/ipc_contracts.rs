// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! IPC decoding contracts at the Tauri command boundary.
//!
//! Tauri's `#[tauri::command]` decoder renames each top-level Rust argument to lower camel case
//! and leaves every nested argument struct to its own serde casing. Plugin commands such as the
//! webview log command are dispatched outside `generate_handler!`, so they parse their arguments
//! independently. These tests drive the real decoder through the same invoke path the renderer
//! uses and pin the wire shape a caller observes: which keys are accepted, which are rejected,
//! and how a plugin command reads its own arguments.
//!
//! A related read-only finding is recorded in the task report rather than locked in here:
//! `NativeService/quickSearch.searchFiles` sends `include_shortcuts`, while the real decoder key
//! for the snake_case Rust argument `include_shortcuts` is `includeShortcuts`. The flag is
//! therefore dropped silently; that is a frontend/argument casing bug owned elsewhere. Isolating
//! it would need to run the real file search on Windows, so no test asserts the current
//! (wrong) behavior.

mod common;

use common::{build_test_app, invoke_command_err, invoke_command_ok, TestAppOptions};
use serde_json::json;
use tauri::test::{mock_context, noop_assets, MockRuntime};
use touchai_lib::testing;

/// The top-level decoder maps a snake_case Rust argument to a camelCase key. A real command
/// proves the mapping: the policy only switches when the caller sends the camelCase key.
#[test]
fn user_sees_a_snake_case_argument_applied_when_the_caller_sends_camel_case() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let response: () = invoke_command_ok(
        &test_app.main_webview,
        "set_search_surface_hide_on_app_blur",
        json!({ "shouldHide": false }),
    );

    assert_eq!(response, ());
    assert!(!testing::search_surface_policies(&test_app.app).hide_on_app_blur);
}

/// The mirror case: the snake_case spelling of the same Rust argument is not the key the
/// decoder reads, so sending it must be rejected and must leave the policy untouched.
#[test]
fn user_sees_a_snake_case_key_rejected_when_the_rust_argument_is_snake_case() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    invoke_command_err(
        &test_app.main_webview,
        "set_search_surface_hide_on_app_blur",
        json!({ "should_hide": false }),
    );

    assert!(testing::search_surface_policies(&test_app.app).hide_on_app_blur);
}

/// Nested argument structs do not follow the top-level rule; their serde casing is their own.
/// A status reminder command whose nested struct renames to camelCase must accept those fields.
#[test]
fn user_sees_nested_status_reminder_parameters_applied_when_their_fields_are_camel_case() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let response: () = invoke_command_ok(
        &test_app.main_webview,
        "show_session_status_reminder_notification",
        json!({
            "payload": {
                "title": "Task completed",
                "body": "The task finished",
                "sessionId": 7,
                "taskId": "task-7",
                "kind": "completed",
                "approval": null,
                "openLabel": "Open",
                "replyPlaceholder": "Reply",
                "replyLabel": "Send"
            }
        }),
    );

    assert_eq!(response, ());
    assert_eq!(
        testing::session_status_reminder_notifications(&test_app.app).len(),
        1
    );
}

/// The nested struct's casing is fixed, so the snake_case spelling of its fields is rejected
/// even though the top-level argument name happens to read the same in either casing.
#[test]
fn user_sees_nested_status_reminder_parameters_rejected_when_their_fields_are_snake_case() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    invoke_command_err(
        &test_app.main_webview,
        "show_session_status_reminder_notification",
        json!({
            "payload": {
                "title": "Task completed",
                "body": "The task finished",
                "session_id": 7,
                "task_id": "task-7",
                "kind": "completed",
                "approval": null,
                "open_label": "Open",
                "reply_placeholder": "Reply",
                "reply_label": "Send"
            }
        }),
    );
}

/// The webview log command is a plugin command (`plugin:log|log`) and never passes through the
/// app's `generate_handler!` dispatcher. The app's own capability grants `log:default`; the mock
/// test context starts with an empty ACL, so this authority allows the command explicitly. That
/// is a test-only, in-memory grant; it does not read or change `capabilities/*.json`. The plugin
/// is built with `skip_logger`, so no global logger is installed and no stdout or file logging
/// happens while the arguments are parsed.
struct LogPluginApp {
    #[allow(dead_code)]
    app: tauri::App<MockRuntime>,
    webview: tauri::WebviewWindow<MockRuntime>,
}

fn build_log_plugin_app() -> LogPluginApp {
    let mut context: tauri::Context<MockRuntime> = mock_context(noop_assets());
    context.runtime_authority_mut().__allow_command(
        "plugin:log|log".to_string(),
        tauri::utils::acl::ExecutionContext::Local,
    );

    let app = testing::test_builder()
        .plugin(
            tauri_plugin_log::Builder::new()
                .skip_logger()
                .build::<MockRuntime>(),
        )
        .build(context)
        .expect("test app");
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::default())
        .build()
        .expect("main test webview");

    LogPluginApp { app, webview }
}

#[test]
fn user_sees_a_log_entry_accepted_when_its_level_and_message_are_valid() {
    let test_app = build_log_plugin_app();

    let response: () = invoke_command_ok(
        &test_app.webview,
        "plugin:log|log",
        json!({ "level": 3, "message": "user opened the search window" }),
    );

    assert_eq!(response, ());
}

#[test]
fn user_sees_a_log_entry_rejected_when_its_level_is_out_of_range() {
    let test_app = build_log_plugin_app();

    invoke_command_err(
        &test_app.webview,
        "plugin:log|log",
        json!({ "level": 99, "message": "out of range" }),
    );
}

#[test]
fn user_sees_a_log_entry_rejected_when_its_message_is_missing() {
    let test_app = build_log_plugin_app();

    invoke_command_err(&test_app.webview, "plugin:log|log", json!({ "level": 3 }));
}
