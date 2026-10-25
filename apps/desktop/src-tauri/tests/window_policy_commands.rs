mod common;

use common::{build_test_app, invoke_command_ok, TestAppOptions};
use serde_json::json;
use touchai_lib::testing;

/// The renderer switches window-hiding and height-override policies as the user moves between
/// the idle search bar and an open conversation. Each switch is observable through the runtime
/// snapshot the test harness exposes, so these tests assert the policy the window will actually
/// follow rather than the call that set it.
#[test]
fn user_gets_focus_hiding_turned_off_when_a_conversation_is_open() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let _: () = invoke_command_ok(
        &test_app.main_webview,
        "set_search_surface_hide_on_app_blur",
        json!({ "shouldHide": false }),
    );

    assert!(!testing::search_surface_policies(&test_app.app).hide_on_app_blur);
}

#[test]
fn user_gets_focus_hiding_back_on_when_the_window_returns_to_idle() {
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
fn user_gets_a_hand_picked_height_allowed_when_they_drag_the_window_edge() {
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
fn user_keeps_the_height_policy_when_only_the_focus_policy_changes() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    // The height policy starts enabled, so a change that wrongly cleared it would show up.
    let _: () = invoke_command_ok(
        &test_app.main_webview,
        "set_search_window_allow_height_override",
        json!({ "allow": true }),
    );
    let _: () = invoke_command_ok(
        &test_app.main_webview,
        "set_search_surface_hide_on_app_blur",
        json!({ "shouldHide": false }),
    );

    let policies = testing::search_surface_policies(&test_app.app);
    assert!(policies.allow_height_override);
    assert!(!policies.hide_on_app_blur);
}
