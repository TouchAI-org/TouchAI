mod common;

use std::{
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};

use common::{
    build_test_app, invoke_command_err, invoke_command_ok, invoke_command_result, TestAppOptions,
};
use serde_json::{json, Value};

#[test]
#[ignore = "requires TOUCHAI_BROWSER_SMOKE_ROOT on G drive and an installed Chrome or Edge"]
fn managed_browser_live_smoke_launches_observes_acts_and_cleans_up() {
    let smoke_root = std::env::var("TOUCHAI_BROWSER_SMOKE_ROOT")
        .expect("TOUCHAI_BROWSER_SMOKE_ROOT must be set for live browser smoke");

    assert!(
        smoke_root.starts_with("G:\\") || smoke_root.starts_with("G:/"),
        "TOUCHAI_BROWSER_SMOKE_ROOT must point at G drive for local smoke runs"
    );

    let test_root =
        PathBuf::from(smoke_root).join(format!("browser-live-smoke-{}", std::process::id()));
    fs::create_dir_all(&test_root).expect("create smoke root");
    std::env::set_var("TEMP", &test_root);
    std::env::set_var("TMP", &test_root);
    let fixture_path = write_fixture(&test_root);
    let server = FixtureServer::start(fixture_path);
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let status: Value = invoke_command_ok(
        &test_app.main_webview,
        "browser_start",
        json!({
            "request": {
                "startupUrl": server.url()
            }
        }),
    );
    assert_eq!(status["status"], json!("connected"));
    assert_eq!(status["managed"], json!(true));
    assert!(status.get("endpoint").is_none());
    let mut stop_guard = BrowserStopGuard::new(&test_app.main_webview);

    let observation = observe_until_refs(&test_app.main_webview);
    let navigation_token = observation["navigationToken"]
        .as_str()
        .expect("navigation token")
        .to_string();
    let refs = observation["domRefs"].as_array().expect("dom refs");
    let input_ref = refs
        .iter()
        .find(|item| {
            item["editable"].as_bool() == Some(true)
                && item["description"]
                    .as_str()
                    .is_some_and(|description| description.contains("Email"))
        })
        .and_then(|item| item["refId"].as_str())
        .expect("email input ref")
        .to_string();
    let submit_ref = refs
        .iter()
        .find(|item| {
            item["description"]
                .as_str()
                .is_some_and(|description| description.contains("Submit"))
        })
        .and_then(|item| item["refId"].as_str())
        .expect("submit button ref")
        .to_string();

    let non_editable_error = invoke_command_err(
        &test_app.main_webview,
        "browser_act",
        json!({
            "request": {
                "action": "type",
                "refId": submit_ref,
                "navigationToken": navigation_token,
                "text": "blocked"
            }
        }),
    );
    assert!(
        non_editable_error
            .as_str()
            .is_some_and(|message| message.contains("Browser target is not editable")),
        "unexpected non-editable error: {non_editable_error:?}"
    );

    let fill_result: Value = invoke_command_ok(
        &test_app.main_webview,
        "browser_act",
        json!({
            "request": {
                "action": "fill",
                "refId": input_ref,
                "navigationToken": navigation_token,
                "value": "person@example.test"
            }
        }),
    );
    assert_eq!(fill_result["ok"], json!(true));

    let click_result: Value = invoke_command_ok(
        &test_app.main_webview,
        "browser_act",
        json!({
            "request": {
                "action": "click",
                "refId": submit_ref,
                "navigationToken": navigation_token
            }
        }),
    );
    assert_eq!(click_result["ok"], json!(true));

    let press_key_result: Value = invoke_command_ok(
        &test_app.main_webview,
        "browser_act",
        json!({
            "request": {
                "action": "press_key",
                "navigationToken": navigation_token,
                "key": "Escape"
            }
        }),
    );
    assert_eq!(press_key_result["ok"], json!(true));

    let scroll_result: Value = invoke_command_ok(
        &test_app.main_webview,
        "browser_act",
        json!({
            "request": {
                "action": "scroll",
                "navigationToken": navigation_token,
                "deltaY": 25
            }
        }),
    );
    assert_eq!(scroll_result["ok"], json!(true));

    let submitted_observation = observe_until_submitted(&test_app.main_webview);
    assert!(
        submitted_observation["domRefs"]
            .as_array()
            .is_some_and(|refs| refs
                .iter()
                .any(|item| item["description"].as_str().is_some_and(
                    |description| description.contains("Submitted: person@example.test")
                ) && item["selector"].as_str() == Some("#result"))),
        "submitted page state was not observed: {submitted_observation:?}"
    );

    let screenshot_observation: Value = invoke_command_ok(
        &test_app.main_webview,
        "browser_observe",
        json!({
            "request": {
                "operation": "screenshot"
            }
        }),
    );
    let screenshot_path = PathBuf::from(
        screenshot_observation["filePath"]
            .as_str()
            .expect("screenshot artifact path"),
    );
    let screenshot = fs::read(&screenshot_path).expect("read screenshot artifact");
    assert!(
        screenshot.len() > 1024,
        "screenshot should contain PNG bytes"
    );
    assert_eq!(screenshot_observation.get("screenshotBase64"), None);

    let diagnostics_observation = observe_until_diagnostics(&test_app.main_webview);
    assert!(
        diagnostics_observation["console"]
            .as_array()
            .is_some_and(|items| items.iter().any(|item| item
                .as_str()
                .is_some_and(|line| line.contains("touchai-smoke-console")))),
        "console diagnostics were not observed: {diagnostics_observation:?}"
    );
    assert!(
        diagnostics_observation["network"]
            .as_array()
            .is_some_and(|items| items.iter().any(|item| item
                .as_str()
                .is_some_and(|line| line.contains("missing-smoke-resource")))),
        "network diagnostics were not observed: {diagnostics_observation:?}"
    );

    let stopped_status: Value =
        invoke_command_ok(&test_app.main_webview, "browser_stop", json!({}));
    assert_eq!(stopped_status["status"], json!("idle"));
    assert_eq!(stopped_status["managed"], json!(false));
    assert!(stopped_status.get("endpoint").is_none());
    stop_guard.disarm();

    wait_for_owned_profile_cleanup(&test_root);
}

struct BrowserStopGuard<'a> {
    webview: &'a tauri::WebviewWindow<tauri::test::MockRuntime>,
    active: bool,
}

impl<'a> BrowserStopGuard<'a> {
    fn new(webview: &'a tauri::WebviewWindow<tauri::test::MockRuntime>) -> Self {
        Self {
            webview,
            active: true,
        }
    }

    fn disarm(&mut self) {
        self.active = false;
    }
}

impl Drop for BrowserStopGuard<'_> {
    fn drop(&mut self) {
        if self.active {
            let _ = invoke_command_result(self.webview, "browser_stop", json!({}));
        }
    }
}

fn write_fixture(root: &Path) -> PathBuf {
    let fixture_path = root.join("fixture.html");
    fs::write(
        &fixture_path,
        r#"<!doctype html>
<html>
  <head><meta charset="utf-8"><title>TouchAI browser smoke</title></head>
  <body>
    <label>Email <input id="email" aria-label="Email" /></label>
    <button id="submit" type="button" onclick="document.getElementById('result').textContent = 'Submitted: ' + document.getElementById('email').value">Submit</button>
    <div id="result" role="button" tabindex="0" aria-label="Result">Waiting</div>
    <div style="height: 1200px"></div>
    <script>
      setInterval(() => {
        console.error('touchai-smoke-console');
        fetch('/missing-smoke-resource?ts=' + Date.now()).catch(() => {});
      }, 250);
    </script>
  </body>
</html>
"#,
    )
    .expect("write fixture");
    fixture_path
}

fn observe_until_refs(webview: &tauri::WebviewWindow<tauri::test::MockRuntime>) -> Value {
    let deadline = Instant::now() + Duration::from_secs(8);
    let mut last_observation = None;
    while Instant::now() < deadline {
        let observation: Value = invoke_command_ok(
            webview,
            "browser_observe",
            json!({
                "request": {
                    "operation": "snapshot"
                }
            }),
        );
        if observation["domRefs"]
            .as_array()
            .is_some_and(|refs| refs.len() >= 2)
        {
            return observation;
        }
        last_observation = Some(observation);
        thread::sleep(Duration::from_millis(200));
    }
    panic!("browser refs did not become available: {last_observation:?}");
}

fn observe_until_submitted(webview: &tauri::WebviewWindow<tauri::test::MockRuntime>) -> Value {
    let deadline = Instant::now() + Duration::from_secs(8);
    let mut last_observation = None;
    while Instant::now() < deadline {
        let observation: Value = invoke_command_ok(
            webview,
            "browser_observe",
            json!({
                "request": {
                    "operation": "snapshot"
                }
            }),
        );
        if observation["domRefs"].as_array().is_some_and(|refs| {
            refs.iter().any(|item| {
                item["description"]
                    .as_str()
                    .is_some_and(|description| description.contains("person@example.test"))
            })
        }) {
            return observation;
        }
        last_observation = Some(observation);
        thread::sleep(Duration::from_millis(200));
    }
    panic!("browser submitted state did not become observable: {last_observation:?}");
}

fn observe_until_diagnostics(webview: &tauri::WebviewWindow<tauri::test::MockRuntime>) -> Value {
    let deadline = Instant::now() + Duration::from_secs(8);
    let mut last_observation = None;
    while Instant::now() < deadline {
        let observation: Value = invoke_command_ok(
            webview,
            "browser_observe",
            json!({
                "request": {
                    "operation": "state",
                    "includeConsole": true,
                    "includeNetwork": true
                }
            }),
        );
        let has_console = observation["console"].as_array().is_some_and(|items| {
            items.iter().any(|item| {
                item.as_str()
                    .is_some_and(|line| line.contains("touchai-smoke-console"))
            })
        });
        let has_network = observation["network"].as_array().is_some_and(|items| {
            items.iter().any(|item| {
                item.as_str()
                    .is_some_and(|line| line.contains("missing-smoke-resource"))
            })
        });
        if has_console && has_network {
            return observation;
        }
        last_observation = Some(observation);
        thread::sleep(Duration::from_millis(200));
    }
    panic!("browser diagnostics did not become observable: {last_observation:?}");
}

fn wait_for_owned_profile_cleanup(root: &Path) {
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        let active_profiles = fs::read_dir(root)
            .map(|entries| {
                entries
                    .flatten()
                    .filter(|entry| is_managed_browser_profile_entry(entry))
                    .count()
            })
            .unwrap_or(0);
        if active_profiles == 0 {
            return;
        }
        thread::sleep(Duration::from_millis(200));
    }
    assert!(
        fs::read_dir(root)
            .map(|entries| {
                entries
                    .flatten()
                    .filter(|entry| is_managed_browser_profile_entry(entry))
                    .count()
            })
            .unwrap_or(0)
            == 0,
        "managed browser profile should be removed after browser_stop"
    );
}

fn is_managed_browser_profile_entry(entry: &fs::DirEntry) -> bool {
    let name = entry.file_name();
    let name = name.to_string_lossy();
    name.starts_with("touchai-browser-") && !name.starts_with("touchai-browser-artifacts")
}

struct FixtureServer {
    url: String,
}

impl FixtureServer {
    fn start(fixture_path: PathBuf) -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind fixture server");
        let port = listener.local_addr().expect("fixture addr").port();
        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                respond_fixture(stream, &fixture_path);
            }
        });
        Self {
            url: format!("http://127.0.0.1:{port}/fixture.html"),
        }
    }

    fn url(&self) -> &str {
        &self.url
    }
}

fn respond_fixture(mut stream: TcpStream, fixture_path: &Path) {
    let mut request_buffer = [0_u8; 1024];
    let read_bytes = stream.read(&mut request_buffer).unwrap_or(0);
    let request = String::from_utf8_lossy(&request_buffer[..read_bytes]);
    if request.starts_with("GET /missing-smoke-resource") {
        let body = b"missing smoke resource";
        let response = format!(
            "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        let _ = stream.write_all(response.as_bytes());
        let _ = stream.write_all(body);
        return;
    }

    let body = fs::read(fixture_path).expect("read fixture");
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.write_all(&body);
}
