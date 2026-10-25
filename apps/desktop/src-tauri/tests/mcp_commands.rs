mod common;

use common::{build_test_app, invoke_command_err, invoke_command_ok, TestAppOptions};
use serde_json::json;

/// The MCP settings page asks for every server's status while it loads, and the model-facing
/// tools address servers by id. These tests drive the commands the renderer calls and assert
/// what a caller receives for a server that was never connected.
#[test]
fn user_gets_an_error_naming_the_server_when_its_status_is_unknown() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let error = invoke_command_err(
        &test_app.main_webview,
        "mcp_get_client_status",
        json!({ "serverId": 42 }),
    );

    assert_eq!(error.to_string(), "\"Server 42 not found\"");
}

#[test]
fn user_gets_an_empty_list_when_no_server_is_connected() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let statuses: Vec<serde_json::Value> = invoke_command_ok(
        &test_app.main_webview,
        "mcp_get_all_client_statuses",
        json!({}),
    );

    assert!(statuses.is_empty(), "unexpected statuses: {statuses:?}");
}

#[test]
fn user_gets_an_error_when_listing_tools_of_an_unknown_server() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let error = invoke_command_err(
        &test_app.main_webview,
        "mcp_list_tools",
        json!({ "serverId": 7 }),
    );

    assert_eq!(error.to_string(), "\"Server 7 not found\"");
}

#[test]
fn user_gets_an_error_when_calling_a_tool_on_an_unknown_server() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let error = invoke_command_err(
        &test_app.main_webview,
        "mcp_call_tool",
        json!({
            "serverId": 7,
            "toolName": "search",
            "arguments": {}
        }),
    );

    assert_eq!(error.to_string(), "\"Server 7 not found\"");
}

#[test]
fn user_gets_an_error_when_disconnecting_an_unknown_server() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let error = invoke_command_err(
        &test_app.main_webview,
        "mcp_disconnect_server",
        json!({ "serverId": 9 }),
    );

    assert_eq!(error.to_string(), "\"Server 9 not found\"");
}

#[test]
fn user_can_disconnect_everything_when_nothing_is_connected() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    // The shutdown path calls this unconditionally.
    let _: () = invoke_command_ok(&test_app.main_webview, "mcp_disconnect_all", json!({}));
}

#[test]
fn user_gets_an_error_when_connecting_a_stdio_server_without_a_command() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let error = invoke_command_err(
        &test_app.main_webview,
        "mcp_connect_server",
        json!({
            "config": {
                "id": 1,
                "name": "misconfigured",
                "transport_type": "stdio",
                "command": null,
                "args": null,
                "env": null,
                "cwd": null,
                "url": null,
                "headers": null,
                "enabled": true,
                "tool_timeout": 30000
            }
        }),
    );

    assert_eq!(
        error.to_string(),
        "\"Command is required for stdio transport\""
    );
}

#[test]
fn user_gets_an_error_when_connecting_an_http_server_without_a_url() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let error = invoke_command_err(
        &test_app.main_webview,
        "mcp_connect_server",
        json!({
            "config": {
                "id": 2,
                "name": "misconfigured",
                "transport_type": "http",
                "command": null,
                "args": null,
                "env": null,
                "cwd": null,
                "url": null,
                "headers": null,
                "enabled": true,
                "tool_timeout": 30000
            }
        }),
    );

    assert_eq!(error.to_string(), "\"URL is required for HTTP transport\"");
}

/// A loopback listener that answers every connection with an immediate 503, so the failure is
/// deterministic. A closed port would be refused by the OS, but a port like 9 may belong to the
/// Discard service, which accepts the connection and never answers.
fn serve_immediate_503() -> u16 {
    use std::io::{BufRead, BufReader, Write};

    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind a loopback port");
    let port = listener.local_addr().expect("local addr").port();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            let mut reader = BufReader::new(match stream.try_clone() {
                Ok(clone) => clone,
                Err(_) => break,
            });
            let mut line = String::new();
            // Drain the request head so the client is not blocked writing to us.
            while reader
                .read_line(&mut line)
                .map(|read| read > 0)
                .unwrap_or(false)
            {
                if line.trim_end().is_empty() {
                    break;
                }
                line.clear();
            }
            let _ = stream.write_all(
                b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            );
            let _ = stream.flush();
        }
    });
    port
}

#[test]
fn user_does_not_see_a_server_that_failed_to_connect() {
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");
    let port = serve_immediate_503();

    let _ = invoke_command_err(
        &test_app.main_webview,
        "mcp_connect_server",
        json!({
            "config": {
                "id": 3,
                "name": "unreachable",
                "transport_type": "http",
                "command": null,
                "args": null,
                "env": null,
                "cwd": null,
                "url": format!("http://127.0.0.1:{port}/mcp"),
                "headers": null,
                "enabled": true,
                "tool_timeout": 30000
            }
        }),
    );

    let statuses: Vec<serde_json::Value> = invoke_command_ok(
        &test_app.main_webview,
        "mcp_get_all_client_statuses",
        json!({}),
    );

    assert!(
        statuses.is_empty(),
        "a server that never connected must not be listed: {statuses:?}"
    );
}
