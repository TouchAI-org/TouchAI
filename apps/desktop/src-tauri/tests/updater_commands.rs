mod common;

use common::{build_test_app, invoke_command_ok, TestAppOptions};
use serde_json::{json, Value};

#[test]
fn updater_check_reports_unsupported_when_app_is_not_velopack_installed() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let response: serde_json::Value = invoke_command_ok(
        &test_app.main_webview,
        "updater_check_for_updates",
        json!({ "channel": "beta" }),
    );

    assert_eq!(response["status"], json!("unsupported"));
    assert_eq!(response["channel"], json!("beta"));
    assert_eq!(response["currentVersion"], Value::Null);
    assert_eq!(response["reason"], json!("not_installed"));
    assert_eq!(
        response["message"],
        json!("应用通过正式安装包安装后才能使用自动更新。")
    );
    assert_eq!(
        response["requirement"],
        json!({
            "required": false,
            "minimumSupportedVersion": null,
            "requiredSeverity": null,
            "requiredReason": null,
            "targetSatisfiesRequirement": true
        })
    );

    if let Some(latest) = response["latest"].as_object() {
        assert!(latest
            .get("version")
            .and_then(Value::as_str)
            .is_some_and(|version| !version.is_empty()));
        assert!(latest
            .get("tag")
            .and_then(Value::as_str)
            .is_some_and(|tag| !tag.is_empty()));
        assert!(latest
            .get("releaseUrl")
            .and_then(Value::as_str)
            .is_some_and(|url| url.starts_with("https://")));
        assert!(latest
            .get("publishedAt")
            .is_some_and(|value| value.is_null() || value.is_string()));
        assert!(latest.get("prerelease").and_then(Value::as_bool).is_some());
        assert!(latest
            .get("releaseNotes")
            .is_some_and(|value| value.is_null() || value.is_string()));
        assert!(latest.get("downloads").and_then(Value::as_array).is_some());
    } else {
        assert_eq!(response["latest"], Value::Null);
    }
}
