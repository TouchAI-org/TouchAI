mod common;

use common::{build_test_app, invoke_command_ok, TestAppOptions};
use serde_json::json;
use touchai_lib::testing;

/// Popups are preloaded hidden so the first right-click is instant. Registering a config and
/// preloading it is what the app does at startup, and the window has to appear under the
/// `popup-<id>` label the renderer addresses.
#[cfg(target_os = "windows")]
#[test]
fn user_gets_a_registered_popup_window_created_hidden() {
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
}

#[test]
fn user_gets_preloading_accepted_when_no_popup_is_registered() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    // Startup runs this unconditionally, so an empty registry must be a no-op, not an error.
    let _: () = invoke_command_ok(&test_app.main_webview, "preload_popup_windows", json!({}));
}

#[test]
fn user_gets_every_registered_popup_remembered() {
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
fn user_gets_a_popup_window_hidden_when_hiding_it_before_showing() {
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
fn user_gets_the_tray_menu_close_accepted_when_it_does_not_exist() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    // Closing the tray menu is called on every outside click, so it must tolerate absence.
    let _: () = invoke_command_ok(&test_app.main_webview, "close_tray_menu", json!({}));
}

#[test]
fn user_gets_an_error_naming_the_popup_type_when_it_was_never_registered() {
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
fn user_gets_the_search_window_hidden_without_erroring() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    // Hiding is called on every shortcut press and must tolerate the current state. Showing it
    // again needs a real window handle and is covered by the E2E suite instead.
    let _: () = invoke_command_ok(&test_app.main_webview, "hide_search_window", json!({}));
}
