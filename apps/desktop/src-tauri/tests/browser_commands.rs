mod common;

use common::{build_test_app, invoke_command_err, invoke_command_ok, TestAppOptions};
use serde_json::json;
use touchai_lib::testing::{
    parse_browser_loopback_endpoint_for_tests, validate_browser_action_for_tests,
    validate_browser_navigation_token_for_tests, validate_browser_url_for_tests,
    validate_browser_websocket_endpoint_for_tests,
};

#[test]
fn endpoint_validation_accepts_loopback_http_origins_only() {
    for (raw, expected_host, expected_origin) in [
        (
            "http://127.0.0.1:9222",
            "127.0.0.1",
            "http://127.0.0.1:9222",
        ),
        (
            "http://localhost:9222",
            "localhost",
            "http://localhost:9222",
        ),
        ("http://[::1]:9222", "::1", "http://[::1]:9222"),
    ] {
        let endpoint = parse_browser_loopback_endpoint_for_tests(raw).expect("valid endpoint");

        assert_eq!(endpoint["host"], json!(expected_host));
        assert_eq!(endpoint["port"], json!(9222));
        assert_eq!(
            endpoint["versionUrl"],
            json!(format!("{expected_origin}/json/version"))
        );
    }
}

#[test]
fn endpoint_validation_rejects_non_loopback_and_url_components() {
    for endpoint in [
        "https://127.0.0.1:9222",
        "http://192.168.1.5:9222",
        "http://127.0.0.1:9222/json/version",
        "http://user:pass@127.0.0.1:9222",
        "http://127.0.0.1:9222?x=1",
        "http://127.0.0.1:9222#fragment",
        "http://[::1]:9222/json/list",
    ] {
        assert!(
            parse_browser_loopback_endpoint_for_tests(endpoint).is_err(),
            "expected {endpoint} to be rejected"
        );
    }
}

#[test]
fn websocket_validation_requires_ws_loopback_and_same_port() {
    for websocket_url in [
        "ws://127.0.0.1:9222/devtools/browser/test",
        "ws://localhost:9222/devtools/browser/test",
        "ws://[::1]:9222/devtools/browser/test",
    ] {
        assert!(
            validate_browser_websocket_endpoint_for_tests(websocket_url, "http://127.0.0.1:9222",)
                .is_ok(),
            "expected {websocket_url} to be accepted"
        );
    }

    for websocket_url in [
        "wss://127.0.0.1:9222/devtools/browser/test",
        "ws://127.0.0.1:9333/devtools/browser/test",
        "ws://192.168.1.5:9222/devtools/browser/test",
        "ws://user:pass@127.0.0.1:9222/devtools/browser/test",
    ] {
        assert!(
            validate_browser_websocket_endpoint_for_tests(websocket_url, "http://127.0.0.1:9222",)
                .is_err(),
            "expected {websocket_url} to be rejected"
        );
    }
}

#[test]
fn managed_start_request_rejects_arbitrary_paths_and_directories() {
    for request in [
        json!({
            "browserPath": "Z:\\missing\\chrome.exe",
            "startupUrl": "about:blank"
        }),
        json!({
            "userDataDir": "G:\\TouchAI\\unsafe-delete-target",
            "startupUrl": "about:blank"
        }),
    ] {
        assert!(
            serde_json::from_value::<touchai_lib::testing::BrowserStartRequestForTests>(request)
                .is_err(),
            "browser_start must not accept caller-controlled executable/profile paths"
        );
    }
}

#[test]
fn managed_start_request_accepts_trusted_browser_executable_path_field() {
    let request =
        serde_json::from_value::<touchai_lib::testing::BrowserStartRequestForTests>(json!({
            "browserExecutablePath": "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            "startupUrl": "about:blank"
        }))
        .expect("browser settings executable path field should be accepted");

    assert_eq!(
        request
            .browser_executable_path
            .as_ref()
            .and_then(|path| path.file_name())
            .and_then(|name| name.to_str()),
        Some("chrome.exe")
    );
}

#[test]
fn managed_start_request_accepts_trusted_browser_data_path_field() {
    let request =
        serde_json::from_value::<touchai_lib::testing::BrowserStartRequestForTests>(json!({
            "browserDataPath": "D:\\TouchAI\\BrowserData",
            "startupUrl": "about:blank"
        }))
        .expect("browser settings data path field should be accepted");

    assert_eq!(
        request
            .browser_data_path
            .as_ref()
            .and_then(|path| path.file_name())
            .and_then(|name| name.to_str()),
        Some("BrowserData")
    );
}

#[test]
fn managed_start_request_accepts_balanced_fingerprint_fields() {
    let request =
        serde_json::from_value::<touchai_lib::testing::BrowserStartRequestForTests>(json!({
            "fingerprintMode": "balanced",
            "fingerprintLocale": "zh-CN",
            "fingerprintTimezone": "Asia/Shanghai",
            "fingerprintUserAgent": "Mozilla/5.0 TouchAI-compatible",
            "fingerprintWindowSize": "1440,900",
            "startupUrl": "about:blank"
        }))
        .expect("balanced fingerprint fields should be accepted");

    assert_eq!(request.fingerprint_locale.as_deref(), Some("zh-CN"));
    assert_eq!(
        request.fingerprint_timezone.as_deref(),
        Some("Asia/Shanghai")
    );
    assert_eq!(request.fingerprint_window_size.as_deref(), Some("1440,900"));
}

#[test]
fn browser_url_policy_accepts_only_web_urls_and_about_blank() {
    for url in [
        "https://example.test/path?q=1",
        "http://127.0.0.1:1420/",
        "about:blank",
        " ABOUT:blank ",
    ] {
        assert!(
            validate_browser_url_for_tests(url).is_ok(),
            "expected {url} to be accepted"
        );
    }

    for url in [
        "--user-data-dir=G:\\TouchAI\\unsafe-profile",
        "--remote-debugging-address=0.0.0.0",
        "-https://example.test",
        "file:///C:/Users/person/secret.html",
        "chrome://version",
        "edge://settings",
        "devtools://devtools/bundled/inspector.html",
        "javascript:alert(document.cookie)",
        "data:text/html,<script>alert(1)</script>",
        "vbscript:msgbox(1)",
        "C:\\Users\\person\\secret.html",
        "https://example.test/\u{0000}",
    ] {
        assert!(
            validate_browser_url_for_tests(url).is_err(),
            "expected {url} to be rejected"
        );
    }
}

#[test]
fn browser_start_rejects_unsafe_startup_url_before_browser_discovery() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    for startup_url in [
        "--user-data-dir=G:\\TouchAI\\unsafe-profile",
        "--remote-debugging-address=0.0.0.0",
        "file:///C:/Users/person/secret.html",
        "javascript:alert(document.cookie)",
        "data:text/html,<script>alert(1)</script>",
    ] {
        let error = invoke_command_err(
            &test_app.main_webview,
            "browser_start",
            json!({
                "request": {
                    "startupUrl": startup_url
                }
            }),
        );
        assert!(
            error
                .as_str()
                .is_some_and(|message| message.contains("Browser URL")),
            "unexpected startup URL error for {startup_url}: {error:?}"
        );
    }
}

#[test]
fn stale_navigation_token_validation_rejects_old_refs() {
    assert!(validate_browser_navigation_token_for_tests("nav-2", "nav-2").is_ok());
    assert_eq!(
        validate_browser_navigation_token_for_tests("nav-1", "nav-2").expect_err("stale ref"),
        "Browser ref is stale; observe again before acting"
    );
}

#[test]
fn ref_action_validation_requires_matching_navigation_token() {
    let reference = json!({
        "refId": "ref-1",
        "navigationToken": "nav-current",
        "description": "input: Email",
        "editable": true,
        "selector": "#email",
        "x": 10.0,
        "y": 20.0
    });

    let request = json!({
        "action": "click",
        "refId": "ref-1",
        "navigationToken": "nav-old"
    });

    assert_eq!(
        validate_browser_action_for_tests(request, vec![reference]).expect_err("stale ref"),
        "Browser ref is stale; observe again before acting"
    );
}

#[test]
fn element_actions_require_observed_refs_and_navigation_tokens() {
    let click_without_ref = json!({
        "action": "click",
        "x": 10,
        "y": 20
    });
    assert!(
        validate_browser_action_for_tests(click_without_ref, vec![]).is_err(),
        "raw coordinates must be rejected before action dispatch"
    );

    let click_without_token = json!({
        "action": "click",
        "refId": "ref-1"
    });
    let reference = json!({
        "refId": "ref-1",
        "navigationToken": "nav-current",
        "description": "button: Submit",
        "editable": false,
        "selector": "#submit",
        "x": 30.0,
        "y": 40.0
    });
    assert_eq!(
        validate_browser_action_for_tests(click_without_token, vec![reference])
            .expect_err("missing navigation token"),
        "Browser action requires navigationToken for ref targets"
    );
}

#[test]
fn fill_form_validation_rejects_stale_or_non_editable_fields() {
    let editable_ref = json!({
        "refId": "ref-1",
        "navigationToken": "nav-current",
        "description": "input: Email",
        "editable": true,
        "selector": "#email",
        "x": 10.0,
        "y": 20.0
    });
    let non_editable_ref = json!({
        "refId": "ref-2",
        "navigationToken": "nav-current",
        "description": "button: Submit",
        "editable": false,
        "selector": "#submit",
        "x": 30.0,
        "y": 40.0
    });

    let stale_request = json!({
        "action": "fill_form",
        "fields": [{
            "refId": "ref-1",
            "navigationToken": "nav-old",
            "value": "person@example.test"
        }]
    });
    assert_eq!(
        validate_browser_action_for_tests(stale_request, vec![editable_ref.clone()])
            .expect_err("stale fill_form field"),
        "Browser ref is stale; observe again before acting"
    );

    let non_editable_request = json!({
        "action": "fill_form",
        "fields": [{
            "refId": "ref-2",
            "navigationToken": "nav-current",
            "value": "not editable"
        }]
    });
    assert_eq!(
        validate_browser_action_for_tests(non_editable_request, vec![non_editable_ref])
            .expect_err("non-editable fill_form field"),
        "Browser target is not editable"
    );
}

#[test]
fn browser_status_defaults_to_idle() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let response: serde_json::Value =
        invoke_command_ok(&test_app.main_webview, "browser_status", json!({}));

    assert_eq!(response["status"], json!("idle"));
    assert_eq!(response["managed"], json!(false));
    assert!(response.get("endpoint").is_none());
    assert_eq!(response["tabs"], json!([]));
}

#[test]
fn browser_connect_existing_rejects_non_loopback_endpoint_before_network_access() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let error = invoke_command_err(
        &test_app.main_webview,
        "browser_connect_existing",
        json!({
            "request": {
                "endpoint": "http://192.168.1.5:9222"
            }
        }),
    );

    assert!(
        error
            .as_str()
            .is_some_and(|message| message.contains("loopback host")),
        "unexpected existing browser endpoint error: {error:?}"
    );
}

#[test]
fn browser_connect_existing_rejects_unknown_fields() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let error = invoke_command_err(
        &test_app.main_webview,
        "browser_connect_existing",
        json!({
            "request": {
                "endpoint": "http://127.0.0.1:9222",
                "rawCdp": true
            }
        }),
    );

    assert!(
        error
            .as_str()
            .is_some_and(|message| message.contains("unknown field `rawCdp`")),
        "unexpected existing browser unknown field error: {error:?}"
    );
}

#[test]
fn browser_navigation_rejects_unsafe_url_before_connection_check() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    for unsafe_url in [
        "--remote-debugging-address=0.0.0.0",
        "file:///C:/Users/person/secret.html",
        "javascript:alert(document.cookie)",
        "data:text/html,<script>alert(1)</script>",
    ] {
        let error = invoke_command_err(
            &test_app.main_webview,
            "browser_navigate",
            json!({
                "request": {
                    "url": unsafe_url
                }
            }),
        );

        assert!(
            error
                .as_str()
                .is_some_and(|message| message.contains("Browser URL")),
            "unexpected navigation URL error for {unsafe_url}: {error:?}"
        );
    }
}

#[test]
fn browser_navigation_and_tab_requests_reject_unknown_fields() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let navigate_error = invoke_command_err(
        &test_app.main_webview,
        "browser_navigate",
        json!({
            "request": {
                "url": "https://example.test",
                "rawCdp": true
            }
        }),
    );
    assert!(
        navigate_error
            .as_str()
            .is_some_and(|message| message.contains("unknown field `rawCdp`")),
        "unexpected navigate unknown field error: {navigate_error:?}"
    );

    let back_error = invoke_command_err(
        &test_app.main_webview,
        "browser_back",
        json!({
            "request": {
                "tabId": "tab-1",
                "endpoint": "http://127.0.0.1:9222"
            }
        }),
    );
    assert!(
        back_error
            .as_str()
            .is_some_and(|message| message.contains("unknown field `endpoint`")),
        "unexpected tab unknown field error: {back_error:?}"
    );
}

#[test]
fn browser_observe_rejects_unsupported_operations_and_unknown_fields() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let missing_operation_error = invoke_command_err(
        &test_app.main_webview,
        "browser_observe",
        json!({
            "request": {}
        }),
    );
    assert!(
        missing_operation_error
            .as_str()
            .is_some_and(|message| message.contains("missing field `operation`")),
        "unexpected missing observe operation error: {missing_operation_error:?}"
    );

    let hidden_screenshot_error = invoke_command_err(
        &test_app.main_webview,
        "browser_observe",
        json!({
            "request": {
                "operation": "state",
                "includeScreenshot": true
            }
        }),
    );
    assert!(
        hidden_screenshot_error
            .as_str()
            .is_some_and(|message| message.contains("unknown field `includeScreenshot`")),
        "unexpected hidden screenshot error: {hidden_screenshot_error:?}"
    );

    let operation_error = invoke_command_err(
        &test_app.main_webview,
        "browser_observe",
        json!({
            "request": {
                "operation": "console"
            }
        }),
    );
    assert!(
        operation_error
            .as_str()
            .is_some_and(|message| message.contains("unknown variant `console`")),
        "unexpected observe operation error: {operation_error:?}"
    );

    let field_error = invoke_command_err(
        &test_app.main_webview,
        "browser_observe",
        json!({
            "request": {
                "operation": "state",
                "rawCdp": true
            }
        }),
    );
    assert!(
        field_error
            .as_str()
            .is_some_and(|message| message.contains("unknown field")),
        "unexpected observe unknown field error: {field_error:?}"
    );
}

#[test]
fn browser_act_rejects_missing_oversized_and_unguarded_page_actions() {
    let editable_ref = json!({
        "refId": "ref-1",
        "navigationToken": "obs-current",
        "description": "input: Email",
        "editable": true,
        "selector": "#email",
        "x": 10.0,
        "y": 20.0
    });

    for (request, expected) in [
        (
            json!({
                "action": "type",
                "refId": "ref-1",
                "navigationToken": "obs-current"
            }),
            "type requires text",
        ),
        (
            json!({
                "action": "fill",
                "refId": "ref-1",
                "navigationToken": "obs-current"
            }),
            "fill requires value",
        ),
        (
            json!({
                "action": "type",
                "refId": "ref-1",
                "navigationToken": "obs-current",
                "text": "x".repeat(16 * 1024 + 1)
            }),
            "Browser action text exceeds the size limit",
        ),
        (
            json!({
                "action": "press_key",
                "key": ""
            }),
            "press_key key is invalid",
        ),
        (
            json!({
                "action": "fill_form",
                "fields": [{
                    "refId": "ref-1",
                    "navigationToken": "obs-current",
                    "value": "x".repeat(16 * 1024 + 1)
                }]
            }),
            "Browser action text exceeds the size limit",
        ),
        (
            json!({
                "action": "fill_form",
                "fields": (0..51)
                    .map(|_| json!({
                        "refId": "ref-1",
                        "navigationToken": "obs-current",
                        "value": "ok"
                    }))
                    .collect::<Vec<_>>()
            }),
            "fill_form field count exceeds the size limit",
        ),
    ] {
        let error = validate_browser_action_for_tests(request, vec![editable_ref.clone()])
            .expect_err("invalid act request must fail");
        assert!(
            error.contains(expected),
            "expected {expected:?}, got {error:?}"
        );
    }
}

#[test]
fn browser_act_rejects_operation_alias_and_unknown_actions_at_serde_boundary() {
    let operation_alias_error = validate_browser_action_for_tests(
        json!({
            "operation": "click",
            "refId": "ref-1",
            "navigationToken": "nav-current"
        }),
        vec![],
    )
    .expect_err("operation alias must be rejected");
    assert!(
        operation_alias_error.contains("missing field `action`")
            || operation_alias_error.contains("unknown field `operation`"),
        "unexpected operation alias error: {operation_alias_error}"
    );

    let unknown_action_error = validate_browser_action_for_tests(
        json!({
            "action": "evaluate",
            "refId": "ref-1",
            "navigationToken": "nav-current"
        }),
        vec![],
    )
    .expect_err("unknown action must be rejected");
    assert!(
        unknown_action_error.contains("unknown variant `evaluate`"),
        "unexpected unknown action error: {unknown_action_error}"
    );
}

#[test]
fn browser_start_failure_sets_error_status() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let error = invoke_command_err(
        &test_app.main_webview,
        "browser_start",
        json!({
            "request": {
                "browserId": "missing-browser"
            }
        }),
    );

    assert!(
        error.as_str().is_some_and(
            |message| message.contains("Supported browser 'missing-browser' was not found")
        ),
        "unexpected error: {error:?}"
    );

    let status: serde_json::Value =
        invoke_command_ok(&test_app.main_webview, "browser_status", json!({}));
    assert_eq!(status["status"], json!("error"));
}

#[test]
fn browser_stop_resets_runtime_to_idle() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let _ = invoke_command_err(
        &test_app.main_webview,
        "browser_start",
        json!({
            "request": {
                "browserId": "missing-browser"
            }
        }),
    );

    let stopped: serde_json::Value =
        invoke_command_ok(&test_app.main_webview, "browser_stop", json!({}));

    assert_eq!(stopped["status"], json!("idle"));
    assert_eq!(stopped["managed"], json!(false));
    assert!(stopped.get("endpoint").is_none());
    assert_eq!(stopped["tabs"], json!([]));
}
