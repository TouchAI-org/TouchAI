mod common;

use common::{build_test_app, invoke_command_ok, TestAppOptions};
use serde_json::json;

#[test]
fn user_closes_a_tray_menu_that_does_not_exist_then_no_error_is_reported() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let _: () = invoke_command_ok(&test_app.main_webview, "close_tray_menu", json!({}));
}

#[test]
fn user_hides_the_search_window_then_no_error_is_reported() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    // Showing the window again needs a real native handle and is covered by desktop E2E.
    let _: () = invoke_command_ok(&test_app.main_webview, "hide_search_window", json!({}));
}
