mod common;

use common::{build_test_app, invoke_command_ok, TestAppOptions};
use serde_json::json;

#[test]
fn updater_check_reports_unsupported_when_app_is_not_velopack_installed() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let response: serde_json::Value = invoke_command_ok(
        &test_app.main_webview,
        "updater_check_for_updates",
        json!({ "channel": "beta" }),
    );

    assert_eq!(
        response,
        json!({
            "status": "unsupported",
            "channel": "beta",
            "currentVersion": null,
            "reason": "not_installed",
            "message": "应用通过正式安装包安装后才能使用自动更新。"
        })
    );
}
