#![cfg(target_os = "windows")]

mod common;

use common::{build_test_app, invoke_command_ok, TestAppOptions};
use serde_json::json;
use std::{
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{
    http::HeaderMap,
    ipc::{CallbackFn, InvokeBody, InvokeResponseBody},
    test::{get_ipc_response, mock_context, noop_assets, MockRuntime, INVOKE_KEY},
    WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use touchai_lib::testing;

#[test]
fn built_in_tools_execute_bash_accepts_missing_stream_arg() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let response: serde_json::Value = invoke_command_ok(
        &test_app.main_webview,
        "built_in_tools_execute_bash",
        json!({
            "request": {
                "executionId": "exec-command-smoke",
                "command": "Write-Output 'alpha'",
                "timeoutMs": 5000
            }
        }),
    );

    assert_eq!(response["success"], json!(true));
    assert_eq!(response["stdout"], json!("alpha"));
    assert_eq!(response["stderr"], json!(""));
    assert_eq!(response["combinedOutput"], json!("alpha"));
}

#[test]
fn built_in_tools_start_bash_returns_before_completion_and_streams_events() {
    const EVENTS_CALLBACK_ID: u32 = 42;

    let captured_events = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
    let interceptor_events = Arc::clone(&captured_events);
    let started_at = Instant::now();
    let app = testing::test_builder()
        .channel_interceptor(move |_webview, callback, index, body| {
            if callback.0 != EVENTS_CALLBACK_ID {
                return false;
            }

            let payload = body
                .clone()
                .deserialize::<serde_json::Value>()
                .expect("stream event should deserialize");
            interceptor_events
                .lock()
                .expect("captured events mutex poisoned")
                .push(json!({
                    "index": index,
                    "capturedAtMs": started_at.elapsed().as_millis(),
                    "payload": payload,
                }));

            true
        })
        .build(mock_context(noop_assets()))
        .expect("test app");
    let main_webview = WebviewWindowBuilder::new(&app, "main", WebviewUrl::default())
        .build()
        .expect("main webview");

    let response: bool = invoke_command_raw(
        &main_webview,
        "built_in_tools_start_bash",
        json!({
            "request": {
                "executionId": "exec-start-stream",
                "command": "Write-Output 'stream-1'; Start-Sleep -Milliseconds 200; Write-Output 'stream-2'; Start-Sleep -Milliseconds 200; Write-Output 'stream-3'",
                "timeoutMs": 5000
            },
            "events": format!("__CHANNEL__:{EVENTS_CALLBACK_ID}")
        }),
    )
    .expect("start_bash should succeed")
    .deserialize()
    .expect("start_bash response should deserialize");

    assert!(response);
    assert!(
        !captured_events
            .lock()
            .expect("captured events mutex poisoned")
            .iter()
            .any(|event| event["payload"]["kind"] == "completed"),
        "start_bash should return before the completed event is emitted"
    );

    let completed_events = wait_for_completed_events(&captured_events);
    let completed_position = completed_events
        .iter()
        .position(|event| event["payload"]["kind"] == "completed")
        .expect("completed event should be present");
    let chunk_events: Vec<_> = completed_events
        .iter()
        .filter(|event| event["payload"]["kind"] == "chunk")
        .cloned()
        .collect();

    assert!(
        !chunk_events.is_empty(),
        "expected at least one streamed chunk"
    );
    assert!(
        completed_events
            .iter()
            .take(completed_position)
            .any(|event| event["payload"]["kind"] == "chunk"),
        "expected chunk events before completion"
    );

    let stdout = chunk_events
        .iter()
        .filter(|event| event["payload"]["stream"] == "stdout")
        .filter_map(|event| event["payload"]["chunk"].as_str())
        .collect::<String>();
    assert!(stdout.contains("stream-1"));
    assert!(stdout.contains("stream-2"));
    assert!(stdout.contains("stream-3"));

    let completed_response = &completed_events[completed_position]["payload"]["response"];
    assert_eq!(completed_response["success"], json!(true));
    let completed_stdout = completed_response["stdout"]
        .as_str()
        .expect("completed stdout should be a string")
        .replace("\r\n", "\n");
    assert_eq!(completed_stdout, "stream-1\nstream-2\nstream-3");
    assert_eq!(completed_response["stderr"], json!(""));

    let first_chunk_at_ms = chunk_events
        .first()
        .and_then(|event| event["capturedAtMs"].as_u64())
        .expect("first chunk should carry a capture timestamp");
    let completed_at_ms = completed_events[completed_position]["capturedAtMs"]
        .as_u64()
        .expect("completed event should carry a capture timestamp");
    assert!(
        completed_at_ms.saturating_sub(first_chunk_at_ms) >= 150,
        "expected the first chunk to arrive well before completion, got first_chunk_at_ms={first_chunk_at_ms}, completed_at_ms={completed_at_ms}"
    );
}

fn invoke_command_raw(
    webview: &WebviewWindow<MockRuntime>,
    command: &str,
    payload: impl serde::Serialize,
) -> Result<InvokeResponseBody, serde_json::Value> {
    get_ipc_response(
        webview,
        tauri::webview::InvokeRequest {
            cmd: command.to_string(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: test_url().parse().expect("valid tauri test url"),
            body: InvokeBody::Json(serde_json::to_value(payload).expect("serializable payload")),
            headers: HeaderMap::new(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
}

fn wait_for_completed_events(
    captured_events: &Arc<Mutex<Vec<serde_json::Value>>>,
) -> Vec<serde_json::Value> {
    let deadline = Instant::now() + Duration::from_secs(15);

    while Instant::now() < deadline {
        let snapshot = captured_events
            .lock()
            .expect("captured events mutex poisoned")
            .clone();
        if snapshot
            .iter()
            .any(|event| event["payload"]["kind"] == "completed")
        {
            return snapshot;
        }

        thread::sleep(Duration::from_millis(25));
    }

    panic!("timed out waiting for completed bash events");
}

fn test_url() -> &'static str {
    if cfg!(any(windows, target_os = "android")) {
        "http://tauri.localhost"
    } else {
        "tauri://localhost"
    }
}
