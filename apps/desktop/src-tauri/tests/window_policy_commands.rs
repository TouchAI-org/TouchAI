mod common;

use common::{build_test_app, invoke_command_ok, TestAppOptions};
use serde_json::json;
use touchai_lib::testing;

/// The renderer switches window-hiding and height-override policies as the user moves between
/// the idle search bar and an open conversation. Each switch is observable through the runtime
/// snapshot the test harness exposes, so these tests assert the policy the window will actually
/// follow rather than the call that set it.
#[test]
fn user_can_turn_off_hiding_when_the_app_loses_focus() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let _: () = invoke_command_ok(
        &test_app.main_webview,
        "set_search_surface_hide_on_app_blur",
        json!({ "shouldHide": false }),
    );

    assert!(!testing::search_surface_policies(&test_app.app).hide_on_app_blur);
}

#[test]
fn user_can_turn_hiding_back_on() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let _: () = invoke_command_ok(
        &test_app.main_webview,
        "set_search_surface_hide_on_app_blur",
        json!({ "shouldHide": false }),
    );
    let _: () = invoke_command_ok(
        &test_app.main_webview,
        "set_search_surface_hide_on_app_blur",
        json!({ "shouldHide": true }),
    );

    assert!(testing::search_surface_policies(&test_app.app).hide_on_app_blur);
}

#[test]
fn user_can_allow_a_hand_picked_window_height() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let _: () = invoke_command_ok(
        &test_app.main_webview,
        "set_search_window_allow_height_override",
        json!({ "allow": true }),
    );

    assert!(testing::search_surface_policies(&test_app.app).allow_height_override);
}

#[test]
fn user_loses_the_hand_picked_height_when_the_conversation_ends() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let _: () = invoke_command_ok(
        &test_app.main_webview,
        "set_search_window_allow_height_override",
        json!({ "allow": true }),
    );
    let _: () = invoke_command_ok(
        &test_app.main_webview,
        "set_search_window_allow_height_override",
        json!({ "allow": false }),
    );

    assert!(!testing::search_surface_policies(&test_app.app).allow_height_override);
}

#[test]
fn user_keeps_the_two_window_policies_independent() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    // Turning one policy off must not disturb the other.
    let _: () = invoke_command_ok(
        &test_app.main_webview,
        "set_search_surface_hide_on_app_blur",
        json!({ "shouldHide": false }),
    );

    let policies = testing::search_surface_policies(&test_app.app);
    assert!(!policies.allow_height_override);
    assert!(!policies.hide_on_app_blur);
}
