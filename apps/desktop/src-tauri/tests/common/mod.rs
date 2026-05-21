use tauri::{
    http::HeaderMap,
    ipc::{CallbackFn, InvokeBody, InvokeResponseBody},
    test::{get_ipc_response, mock_context, noop_assets, MockRuntime, INVOKE_KEY},
    App, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tempfile::TempDir;
use touchai_lib::testing;

pub struct TestApp {
    #[allow(dead_code)]
    pub app: App<MockRuntime>,
    pub main_webview: WebviewWindow<MockRuntime>,
    _database_root: Option<TempDir>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TestAppOptions {
    pub include_database_runtime: bool,
}

impl TestAppOptions {
    #[allow(dead_code)]
    pub fn with_database_runtime() -> Self {
        Self {
            include_database_runtime: true,
        }
    }
}

pub fn build_test_app(options: TestAppOptions) -> Result<TestApp, String> {
    let mut builder = testing::test_builder();
    let mut database_root = None;

    if options.include_database_runtime {
        let root = TempDir::new().map_err(|error| format!("Failed to create temp dir: {error}"))?;
        builder = testing::attach_test_database_runtime(builder, root.path())?;
        database_root = Some(root);
    }

    let app = builder
        .build(mock_context(noop_assets()))
        .map_err(|error| format!("Failed to build test app: {error}"))?;
    let main_webview = WebviewWindowBuilder::new(&app, "main", WebviewUrl::default())
        .build()
        .map_err(|error| format!("Failed to build main test webview: {error}"))?;

    Ok(TestApp {
        app,
        main_webview,
        _database_root: database_root,
    })
}

pub fn invoke_command_ok<T: serde::de::DeserializeOwned>(
    webview: &WebviewWindow<MockRuntime>,
    command: &str,
    payload: impl serde::Serialize,
) -> T {
    invoke_command(webview, command, payload)
        .unwrap_or_else(|error| panic!("Expected '{command}' to succeed, got error: {error}"))
        .deserialize::<T>()
        .unwrap_or_else(|error| panic!("Failed to deserialize '{command}' response: {error}"))
}

#[allow(dead_code)]
pub fn invoke_command_err(
    webview: &WebviewWindow<MockRuntime>,
    command: &str,
    payload: impl serde::Serialize,
) -> serde_json::Value {
    invoke_command(webview, command, payload).expect_err(&format!("Expected '{command}' to fail"))
}

fn invoke_command(
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

fn test_url() -> &'static str {
    if cfg!(any(windows, target_os = "android")) {
        "http://tauri.localhost"
    } else {
        "tauri://localhost"
    }
}
