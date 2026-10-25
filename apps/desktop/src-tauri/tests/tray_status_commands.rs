mod common;

use common::{build_test_app, invoke_command_ok, TestAppOptions};
use serde_json::json;
use touchai_lib::testing;

/// The tray icon carries a small status badge while a conversation is running, so the user can
/// see from the taskbar whether something failed or is waiting on them. These tests drive the
/// commands the renderer calls and read the status the tray will show.
#[test]
fn user_sees_a_failed_badge_while_a_conversation_has_failed() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let _: () = invoke_command_ok(
        &test_app.main_webview,
        "set_tray_status_indicator",
        json!({ "status": "failed" }),
    );

    assert_eq!(
        testing::tray_status_indicator(&test_app.app).as_deref(),
        Some("failed")
    );
}

#[test]
fn user_sees_a_waiting_badge_when_a_tool_needs_approval() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let _: () = invoke_command_ok(
        &test_app.main_webview,
        "set_tray_status_indicator",
        json!({ "status": "waiting_approval" }),
    );

    assert_eq!(
        testing::tray_status_indicator(&test_app.app).as_deref(),
        Some("waiting_approval")
    );
}

#[test]
fn user_loses_the_badge_when_the_conversation_finishes() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let _: () = invoke_command_ok(
        &test_app.main_webview,
        "set_tray_status_indicator",
        json!({ "status": "completed" }),
    );
    let _: () = invoke_command_ok(
        &test_app.main_webview,
        "clear_tray_status_indicator",
        json!({}),
    );

    assert_eq!(testing::tray_status_indicator(&test_app.app), None);
}

#[test]
fn user_gets_the_latest_badge_when_the_status_changes() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let _: () = invoke_command_ok(
        &test_app.main_webview,
        "set_tray_status_indicator",
        json!({ "status": "completed" }),
    );
    let _: () = invoke_command_ok(
        &test_app.main_webview,
        "set_tray_status_indicator",
        json!({ "status": "failed" }),
    );

    assert_eq!(
        testing::tray_status_indicator(&test_app.app).as_deref(),
        Some("failed")
    );
}

#[test]
fn user_clearing_an_absent_badge_is_harmless() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    // Shutdown clears the badge unconditionally, so an absent one must not error.
    let _: () = invoke_command_ok(
        &test_app.main_webview,
        "clear_tray_status_indicator",
        json!({}),
    );

    assert_eq!(testing::tray_status_indicator(&test_app.app), None);
}
