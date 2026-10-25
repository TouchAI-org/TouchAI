mod common;

use common::{build_test_app, invoke_command_ok, TestAppOptions};
use serde_json::json;
use touchai_lib::testing;

/// Popups are preloaded hidden so the first right-click is instant. Registering a config and
/// preloading it is what the app does at startup, and the window has to appear under the
/// `popup-<id>` label the renderer addresses.
#[cfg(target_os = "windows")]
#[test]
fn user_registers_a_popup_when_preloading_then_the_window_exists_hidden() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let _: () = invoke_command_ok(
        &test_app.main_webview,
        "register_popup_configs",
        json!({
            "configs": [{
                "id": "e2e-popup",
                "width": 320.0,
                "height": 384.0
            }]
        }),
    );

    let _: () = invoke_command_ok(&test_app.main_webview, "preload_popup_windows", json!({}));

    assert!(
        testing::popup_registry_has(&test_app.app, "e2e-popup"),
        "the popup config was not registered"
    );
    // Preloading logs creation failures and still succeeds, so the window itself is the proof.
    // The hidden flag is not asserted here: MockRuntime reports every window as visible, so the
    // initial-hidden contract is covered by the E2E suite instead.
    use tauri::Manager;
    assert!(
        test_app.app.get_webview_window("popup-e2e-popup").is_some(),
        "the popup window should have been created"
    );
}

#[test]
fn user_preloads_when_nothing_is_registered_then_it_is_a_no_op() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    // Startup runs this unconditionally, so an empty registry must be a no-op, not an error.
    let _: () = invoke_command_ok(&test_app.main_webview, "preload_popup_windows", json!({}));
}

#[test]
fn user_registers_two_popups_then_both_are_remembered() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let _: () = invoke_command_ok(
        &test_app.main_webview,
        "register_popup_configs",
        json!({
            "configs": [
                { "id": "first-popup", "width": 320.0, "height": 384.0 },
                { "id": "second-popup", "width": 480.0, "height": 512.0 }
            ]
        }),
    );

    assert!(testing::popup_registry_has(&test_app.app, "first-popup"));
    assert!(testing::popup_registry_has(&test_app.app, "second-popup"));
}

#[test]
fn user_hides_a_popup_that_was_never_shown_then_no_error_is_reported() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    // Hiding a popup that was never shown must not error; the renderer calls this on blur.
    let _: () = invoke_command_ok(
        &test_app.main_webview,
        "hide_popup_window",
        json!({
            "params": {
                "popupId": "never-shown",
                "windowLabel": "popup-never-shown",
                "popupSessionVersion": 1
            }
        }),
    );
}

#[test]
fn user_closes_a_tray_menu_that_does_not_exist_then_no_error_is_reported() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    // Closing the tray menu is called on every outside click, so it must tolerate absence.
    let _: () = invoke_command_ok(&test_app.main_webview, "close_tray_menu", json!({}));
}

#[test]
fn user_shows_an_unregistered_popup_then_the_error_names_the_type() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    // The renderer can ask for a popup whose config has not arrived yet; it must say which
    // type was missing rather than failing silently.
    let error = common::invoke_command_err(
        &test_app.main_webview,
        "show_popup_window",
        json!({
            "params": {
                "x": 0.0,
                "y": 0.0,
                "width": 320.0,
                "height": 384.0,
                "popupType": "unregistered-popup",
                "popupId": "p1",
                "windowLabel": "popup-unregistered-popup",
                "popupSessionVersion": 1
            }
        }),
    );

    assert_eq!(
        error.to_string(),
        "\"Popup type 'unregistered-popup' not registered\""
    );
}

#[test]
fn user_hides_the_search_window_then_no_error_is_reported() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    // Hiding is called on every shortcut press and must tolerate the current state. Showing it
    // again needs a real window handle and is covered by the E2E suite instead.
    let _: () = invoke_command_ok(&test_app.main_webview, "hide_search_window", json!({}));
}
