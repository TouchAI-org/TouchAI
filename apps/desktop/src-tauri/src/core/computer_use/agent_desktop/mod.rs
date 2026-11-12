use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use rmcp::model::{CallToolRequest, CallToolRequestParams, ClientRequest, ServerResult};
use rmcp::service::{PeerRequestOptions, RunningService, ServiceExt};
use rmcp::transport::TokioChildProcess;
use serde_json::{json, Value};
use tokio::sync::oneshot;

use crate::core::window::computer_use_glow::PointerPosition;

mod feedback;
mod manifest;
use feedback::Feedback;

use self::manifest::MANIFEST;
use super::backend::{DriverStatus, UpdateInfo};
use super::manifest::artifact;
use super::provision::{
    confirm_install, ensure_installed, installed_binary, installed_size, InstallLayout,
    WheelFetcher,
};

type Service = RunningService<rmcp::RoleClient, ()>;

struct Runtime {
    service: Service,
    root: PathBuf,
    headed: bool,
    tools: Vec<Value>,
}

#[derive(Default)]
struct State {
    runtime: Option<Runtime>,
    recording: Option<(PathBuf, PathBuf)>,
    scope_directory: Option<tempfile::TempDir>,
    feedback: Feedback,
}

static STATE: tokio::sync::Mutex<State> = tokio::sync::Mutex::const_new(State {
    runtime: None,
    recording: None,
    scope_directory: None,
    feedback: Feedback::new(),
});
static INSTALLING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
type SessionStates = HashMap<String, Arc<tokio::sync::Mutex<State>>>;
static SESSIONS: OnceLock<tokio::sync::Mutex<SessionStates>> = OnceLock::new();
static CALLS: OnceLock<Mutex<HashMap<String, oneshot::Sender<()>>>> = OnceLock::new();

fn calls() -> &'static Mutex<HashMap<String, oneshot::Sender<()>>> {
    CALLS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn sessions() -> &'static tokio::sync::Mutex<SessionStates> {
    SESSIONS.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()))
}

pub async fn end_activity(activity_id: &str) -> Result<(), String> {
    let state = sessions().lock().await.remove(activity_id);
    if let Some(state) = state {
        stop_runtime(&mut *state.lock().await).await?;
    }
    Ok(())
}

async fn stop_sessions() -> Result<(), String> {
    let states: Vec<_> = sessions()
        .lock()
        .await
        .drain()
        .map(|(_, state)| state)
        .collect();
    for state in states {
        stop_runtime(&mut *state.lock().await).await?;
    }
    Ok(())
}

fn binary(root: &Path) -> Result<Option<PathBuf>, String> {
    let artifact = artifact(&MANIFEST).ok_or("agent-desktop is unavailable on this platform")?;
    installed_binary(&InstallLayout::new(root), MANIFEST.version, artifact)
        .map_err(|error| error.to_string())
}

pub fn status(root: &Path) -> Result<DriverStatus, String> {
    let binary = binary(root)?;
    Ok(DriverStatus {
        installed: binary.is_some(),
        driver_version: binary.as_ref().map(|_| MANIFEST.version.to_string()),
        installed_size_bytes: binary.as_deref().and_then(installed_size),
        binary: binary.map(|path| path.display().to_string()),
        abi_version: None,
        metadata: Some(json!({"driver": "agent-desktop", "transport": "stdio"})),
        error: None,
    })
}

pub async fn prepare<F: WheelFetcher>(root: PathBuf, fetcher: &F) -> Result<DriverStatus, String> {
    let _installing = INSTALLING.lock().await;
    let artifact = artifact(&MANIFEST).ok_or("agent-desktop is unavailable on this platform")?;
    ensure_installed(
        fetcher,
        &InstallLayout::new(&root),
        MANIFEST.version,
        artifact,
        &MANIFEST.mirrors,
    )
    .await
    .map_err(|error| error.to_string())?;
    list_tools(root.clone()).await?;
    status(&root)
}

async fn stop_runtime(state: &mut State) -> Result<(), String> {
    state.feedback.clear();
    if let Some(runtime) = state.runtime.take() {
        runtime
            .service
            .cancel()
            .await
            .map_err(|error| format!("agent-desktop shutdown: {error}"))?;
    }
    Ok(())
}

async fn ensure_runtime(
    state: &mut State,
    root: &Path,
    headed: bool,
    activity_id: Option<&str>,
) -> Result<(), String> {
    if state.runtime.as_ref().is_some_and(|runtime| {
        runtime.root == root && runtime.headed == headed && !runtime.service.is_closed()
    }) {
        return Ok(());
    }
    stop_runtime(state).await?;
    let binary = binary(root)?.ok_or("agent-desktop is not installed")?;
    if activity_id.is_some() && state.scope_directory.is_none() {
        let parent = root.join("state");
        state.scope_directory = Some(
            tokio::task::spawn_blocking(move || {
                std::fs::create_dir_all(&parent)?;
                tempfile::Builder::new()
                    .prefix("activity-")
                    .tempdir_in(parent)
            })
            .await
            .map_err(|error| error.to_string())?
            .map_err(|error| error.to_string())?,
        );
    }
    let mut command = tokio::process::Command::new(binary);
    command
        .arg("mcp")
        .env(
            "AGENT_DESKTOP_HOME",
            state
                .scope_directory
                .as_ref()
                .map(|directory| directory.path().to_path_buf())
                .unwrap_or_else(|| root.join("state")),
        )
        .env_remove("AGENT_DESKTOP_SESSION")
        .env_remove("AGENT_DESKTOP_AGENT_ID");
    if let Some(activity_id) = activity_id {
        command
            .arg("--session")
            .arg(format!("touchai-{activity_id}"))
            .arg("--agent-id")
            .arg(format!("touchai-{activity_id}"));
    }
    if headed {
        command.arg("--headed");
    }
    if let Some((_, trace)) = &state.recording {
        command.arg("--trace").arg(trace).arg("--trace-strict");
    }
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let (transport, _) = TokioChildProcess::builder(command)
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("agent-desktop could not start: {error}"))?;
    let service = tokio::time::timeout(Duration::from_secs(10), ().serve(transport))
        .await
        .map_err(|_| "agent-desktop handshake timed out")?
        .map_err(|error| format!("agent-desktop handshake failed: {error}"))?;
    let tools = tokio::time::timeout(Duration::from_secs(10), service.peer().list_all_tools())
        .await
        .map_err(|_| "agent-desktop catalog timed out")?
        .map_err(|error| format!("agent-desktop catalog failed: {error}"))?
        .into_iter()
        .map(|tool| {
            let mut definition = serde_json::to_value(tool).map_err(|error| error.to_string())?;
            let read_only = is_read_only(definition["name"].as_str().unwrap_or_default());
            definition["annotations"] = json!({"readOnlyHint": read_only});
            Ok(definition)
        })
        .collect::<Result<Vec<_>, String>>()?;
    if tools.is_empty() {
        return Err("agent-desktop returned no tools".into());
    }
    let install_root = root.to_path_buf();
    tokio::task::spawn_blocking(move || {
        confirm_install(
            &InstallLayout::new(install_root),
            MANIFEST.version,
            artifact(&MANIFEST).ok_or("unsupported agent-desktop platform")?,
        )
        .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())??;
    state.runtime = Some(Runtime {
        service,
        root: root.to_path_buf(),
        headed,
        tools,
    });
    Ok(())
}

pub fn is_read_only(tool: &str) -> bool {
    matches!(
        tool,
        "desktop_snapshot"
            | "desktop_find"
            | "desktop_get"
            | "desktop_is"
            | "desktop_list_windows"
            | "desktop_list_apps"
            | "desktop_list_displays"
            | "desktop_list_surfaces"
            | "desktop_list_notifications"
            | "desktop_status"
            | "desktop_version"
            | "desktop_skills_get"
            | "desktop_skills_list"
            | "desktop_skills_path"
            | "desktop_session_list"
            | "desktop_trace_show"
            | "desktop_wait"
    )
}

pub async fn list_tools(root: PathBuf) -> Result<Vec<Value>, String> {
    if binary(&root)?.is_none() {
        return Ok(Vec::new());
    }
    let mut state = STATE.lock().await;
    let headed = state.runtime.as_ref().is_some_and(|runtime| runtime.headed);
    ensure_runtime(&mut state, &root, headed, None).await?;
    Ok(state
        .runtime
        .as_ref()
        .ok_or("agent-desktop did not start")?
        .tools
        .clone())
}

struct Execution(String);

impl Drop for Execution {
    fn drop(&mut self) {
        if let Ok(mut calls) = calls().lock() {
            calls.remove(&self.0);
        }
    }
}

#[cfg(test)]
pub async fn invoke(
    root: PathBuf,
    execution_id: String,
    tool: String,
    arguments: Value,
    headed: bool,
) -> Result<Value, String> {
    invoke_scoped(root, execution_id, tool, arguments, headed, None).await
}

#[cfg(test)]
pub async fn invoke_scoped(
    root: PathBuf,
    execution_id: String,
    tool: String,
    arguments: Value,
    headed: bool,
    activity_id: Option<&str>,
) -> Result<Value, String> {
    invoke_cancellable(
        root,
        execution_id,
        tool,
        arguments,
        headed,
        activity_id,
        None,
        None,
    )
    .await
}

pub async fn invoke_cancellable(
    root: PathBuf,
    execution_id: String,
    tool: String,
    arguments: Value,
    headed: bool,
    activity_id: Option<&str>,
    activity_cancelled: Option<tokio::sync::watch::Receiver<bool>>,
    report_pointer: Option<&(dyn Fn(PointerPosition) + Send + Sync)>,
) -> Result<Value, String> {
    let (sender, mut cancelled) = oneshot::channel();
    {
        let mut calls = calls()
            .lock()
            .map_err(|_| "agent-desktop execution lock poisoned")?;
        if calls.contains_key(&execution_id) {
            return Err("duplicate computer use execution id".into());
        }
        if calls.len() >= 32 {
            return Err("too many pending desktop actions".into());
        }
        calls.insert(execution_id.clone(), sender);
    }
    let _execution = Execution(execution_id);
    if activity_cancelled
        .as_ref()
        .is_some_and(|receiver| *receiver.borrow() || receiver.has_changed().is_err())
    {
        return Err("computer use cancelled before execution".into());
    }
    let scoped = if let Some(activity_id) = activity_id {
        let recording = STATE.lock().await.recording.clone();
        let mut states = sessions().lock().await;
        if states.len() >= 32 && !states.contains_key(activity_id) {
            return Err("too many active desktop sessions".into());
        }
        Some(Arc::clone(states.entry(activity_id.into()).or_insert_with(
            || {
                Arc::new(tokio::sync::Mutex::new(State {
                    runtime: None,
                    recording,
                    scope_directory: None,
                    feedback: Feedback::new(),
                }))
            },
        )))
    } else {
        None
    };
    let state_lock = scoped.as_deref().unwrap_or(&STATE);
    let mut state = tokio::select! {
        biased;
        _ = &mut cancelled => return Err("computer use cancelled before execution".into()),
        state = state_lock.lock() => state,
    };
    ensure_runtime(&mut state, &root, headed, activity_id).await?;
    if cancelled.try_recv().is_ok()
        || activity_cancelled
            .as_ref()
            .is_some_and(|receiver| *receiver.borrow() || receiver.has_changed().is_err())
    {
        return Err("computer use cancelled before execution".into());
    }
    let runtime = state
        .runtime
        .as_ref()
        .ok_or("agent-desktop did not start")?;
    if !runtime.tools.iter().any(|entry| entry["name"] == tool) {
        return Err(format!("unknown agent-desktop tool: {tool}"));
    }
    if let (Some(report), Some(pointer)) = (
        report_pointer,
        state.feedback.target(&tool, &arguments, None),
    ) {
        report(pointer);
    }
    let mut args = arguments
        .as_object()
        .cloned()
        .ok_or("driver arguments must be an object")?;
    let hide_bounds = report_pointer.is_some()
        && tool == "desktop_snapshot"
        && args.get("include_bounds") != Some(&Value::Bool(true));
    if hide_bounds {
        args.insert("include_bounds".into(), Value::Bool(true));
    }
    let timeout = if tool == "desktop_batch" {
        Duration::from_secs(65)
    } else {
        Duration::from_secs(30)
    };
    let window_list = tool == "desktop_list_windows";
    let params = CallToolRequestParams::new(tool.clone()).with_arguments(args);
    let mut request = runtime
        .service
        .peer()
        .send_request_with_option(
            ClientRequest::CallToolRequest(CallToolRequest::new(params)),
            PeerRequestOptions::default(),
        )
        .await
        .map_err(|error| error.to_string())?;
    let response = tokio::select! {
        biased;
        _ = &mut cancelled => {
            request.cancel(Some("TouchAI cancelled the desktop action".into())).await.map_err(|error| error.to_string())?;
            return Err("computer use cancelled; completed effects are not undone".into());
        },
        response = &mut request.rx => response.map_err(|_| "agent-desktop disconnected")?.map_err(|error| error.to_string())?,
        _ = tokio::time::sleep(timeout) => {
            request.cancel(Some("TouchAI desktop action timed out".into())).await.map_err(|error| error.to_string())?;
            return Err("agent-desktop timed out; cancellation sent, observe the target before retrying".into());
        }
    };
    match response {
        ServerResult::CallToolResult(result) => {
            let mut result = serde_json::to_value(result).map_err(|error| error.to_string())?;
            state.feedback.observe(&result);
            if let (Some(report), Some(pointer)) = (
                report_pointer,
                state.feedback.target(&tool, &arguments, Some(&result)),
            ) {
                report(pointer);
            }
            if hide_bounds {
                feedback::hide_bounds(&mut result);
            }
            if window_list {
                exclude_feedback_window(&mut result, std::process::id());
            }
            Ok(result)
        }
        _ => Err("agent-desktop returned an unexpected response".into()),
    }
}

fn exclude_feedback_window(result: &mut Value, process_id: u32) {
    let Some(windows) = result["structuredContent"]["data"].as_array_mut() else {
        return;
    };
    let count = windows.len();
    windows.retain(|window| {
        window["pid"].as_u64() != Some(u64::from(process_id))
            || window["title"] != crate::core::window::computer_use_glow::WINDOW_TITLE
    });
    if windows.len() != count {
        result["content"] =
            json!([{ "type": "text", "text": result["structuredContent"].to_string() }]);
    }
}

pub fn cancel(execution_id: &str) -> bool {
    calls()
        .lock()
        .ok()
        .and_then(|mut calls| calls.remove(execution_id))
        .is_some_and(|sender| sender.send(()).is_ok())
}

pub fn cancel_all() -> usize {
    let Ok(mut calls) = calls().lock() else {
        return 0;
    };
    calls
        .drain()
        .filter(|(_, sender)| !sender.is_closed())
        .map(|(_, sender)| usize::from(sender.send(()).is_ok()))
        .sum()
}

pub async fn shutdown() -> Result<(), String> {
    cancel_all();
    stop_sessions().await?;
    let mut state = STATE.lock().await;
    stop_runtime(&mut state).await?;
    state.recording = None;
    Ok(())
}

pub async fn remove(root: &Path) -> Result<(), String> {
    let _installing = INSTALLING.lock().await;
    shutdown().await?;
    if root.exists() {
        std::fs::remove_dir_all(root).map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub async fn set_recording(enabled: bool, directory: &Path) -> Result<(), String> {
    let mut state = STATE.lock().await;
    if enabled
        && state
            .recording
            .as_ref()
            .is_some_and(|(root, _)| root == directory)
    {
        return Ok(());
    }
    if !enabled && state.recording.is_none() {
        return Ok(());
    }
    let recording = if enabled {
        let directory = directory.to_path_buf();
        Some(
            tokio::task::spawn_blocking(move || {
                let run = super::recording::create_recording_directory(&directory)?;
                let trace = run.join("trace.jsonl");
                std::fs::File::create(&trace).map_err(|error| error.to_string())?;
                Ok::<_, String>((directory, trace))
            })
            .await
            .map_err(|error| error.to_string())??,
        )
    } else {
        None
    };
    stop_runtime(&mut state).await?;
    state.recording = recording;
    drop(state);
    stop_sessions().await?;
    Ok(())
}

pub async fn check_update() -> UpdateInfo {
    let result = async {
        let client = reqwest::Client::builder()
            .user_agent(concat!("TouchAI/", env!("CARGO_PKG_VERSION")))
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|error| error.to_string())?;
        let fetcher =
            super::http::HttpWheelFetcher::new(concat!("TouchAI/", env!("CARGO_PKG_VERSION")))?;
        let mut last_error = "agent-desktop registry unavailable".to_string();
        for url in fetcher
            .sources(&MANIFEST.mirrors, "/agent-desktop/latest")
            .await
        {
            let response = async {
                let value: Value = client
                    .get(&url)
                    .send()
                    .await
                    .map_err(|error| error.to_string())?
                    .error_for_status()
                    .map_err(|error| error.to_string())?
                    .json()
                    .await
                    .map_err(|error| error.to_string())?;
                let version = value["version"]
                    .as_str()
                    .ok_or("agent-desktop registry returned no version")?;
                semver::Version::parse(version).map_err(|error| error.to_string())?;
                Ok::<String, String>(version.to_string())
            }
            .await;
            match response {
                Ok(version) => return Ok(version),
                Err(error) => last_error = error,
            }
        }
        Err(last_error)
    }
    .await;
    match result {
        Ok(latest) => UpdateInfo {
            current: MANIFEST.version.into(),
            update_available: super::http::compare(&latest, MANIFEST.version).is_gt(),
            latest: Some(latest),
            error: None,
        },
        Err(error) => UpdateInfo {
            current: MANIFEST.version.into(),
            latest: None,
            update_available: false,
            error: Some(error),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::super::provision::Fetched;
    use super::*;

    #[test]
    fn user_given_control_feedback_when_listing_windows_then_sees_only_actionable_windows() {
        let title = crate::core::window::computer_use_glow::WINDOW_TITLE;
        let mut result = json!({"structuredContent":{"data":[{"pid":42,"title":title},{"pid":42,"title":"TouchAI"},{"pid":43,"title":title}]},"content":[{"type":"text","text":"old"}]});
        exclude_feedback_window(&mut result, 42);
        assert_eq!(
            result["structuredContent"]["data"],
            json!([{"pid":42,"title":"TouchAI"},{"pid":43,"title":title}])
        );
        let text: Value =
            serde_json::from_str(result["content"][0]["text"].as_str().expect("text"))
                .expect("list");
        assert_eq!(text, result["structuredContent"]);
    }

    #[tokio::test]
    async fn user_given_stopped_activity_when_a_delayed_action_registers_then_never_starts_a_driver(
    ) {
        let (_sender, cancelled) = tokio::sync::watch::channel(true);
        let result = invoke_cancellable(
            PathBuf::from("missing-fixture"),
            "delayed-stopped".into(),
            "desktop_type".into(),
            json!({"text":"must not type"}),
            true,
            Some("stopped"),
            Some(cancelled),
            None,
        )
        .await;
        assert_eq!(
            result.expect_err("stopped action"),
            "computer use cancelled before execution"
        );
        assert!(!cancel("delayed-stopped"));
    }

    struct ReleaseFetcher(Vec<u8>);

    impl WheelFetcher for ReleaseFetcher {
        async fn fetch(&self, _url: &str, offset: u64) -> Result<Fetched, String> {
            Ok(Fetched {
                bytes: self.0[offset as usize..].to_vec(),
                restart: false,
            })
        }
    }

    #[tokio::test]
    #[ignore = "requires the pinned native release archive in TOUCHAI_TEST_AGENT_DESKTOP_ARCHIVE"]
    async fn user_given_the_native_release_when_recording_cancelling_and_restarting_then_retains_a_usable_driver(
    ) {
        let archive = std::env::var("TOUCHAI_TEST_AGENT_DESKTOP_ARCHIVE").expect("release archive");
        let directory = tempfile::tempdir().expect("fixture directory");
        let root = directory.path().join("agent-desktop");
        assert!(!status(&root).expect("missing status").installed);
        let installed = prepare(
            root.clone(),
            &ReleaseFetcher(std::fs::read(archive).expect("archive")),
        )
        .await
        .expect("install");
        assert!(installed.installed);
        let tools = list_tools(root.clone()).await.expect("catalog");
        assert!(tools.iter().any(|tool| tool["name"] == "desktop_snapshot"));
        assert!(tools.iter().any(|tool| tool["name"] == "desktop_batch"));
        let version = invoke(
            root.clone(),
            "version".into(),
            "desktop_version".into(),
            json!({}),
            false,
        )
        .await
        .expect("version");
        assert_eq!(version["structuredContent"]["ok"], true);
        let (first, second) = tokio::join!(
            invoke_scoped(
                root.clone(),
                "scope-one-status".into(),
                "desktop_status".into(),
                json!({}),
                false,
                Some("scope-one")
            ),
            invoke_scoped(
                root.clone(),
                "scope-two-status".into(),
                "desktop_status".into(),
                json!({}),
                false,
                Some("scope-two")
            )
        );
        let first = first.expect("first session");
        let second = second.expect("second session");
        assert_eq!(
            first["structuredContent"]["data"]["session_id"],
            "touchai-scope-one"
        );
        assert_eq!(
            second["structuredContent"]["data"]["session_id"],
            "touchai-scope-two"
        );
        let first_root = PathBuf::from(
            first["structuredContent"]["data"]["state_root"]
                .as_str()
                .expect("first state"),
        );
        let second_root = PathBuf::from(
            second["structuredContent"]["data"]["state_root"]
                .as_str()
                .expect("second state"),
        );
        assert_ne!(first_root, second_root);
        end_activity("scope-one")
            .await
            .expect("release first session");
        assert!(!first_root.exists());
        assert!(second_root.exists());
        let remaining = invoke_scoped(
            root.clone(),
            "scope-two-remains".into(),
            "desktop_status".into(),
            json!({}),
            false,
            Some("scope-two"),
        )
        .await
        .expect("remaining session");
        assert_eq!(
            remaining["structuredContent"]["data"]["session_id"],
            "touchai-scope-two"
        );
        end_activity("scope-two")
            .await
            .expect("release second session");
        assert!(!second_root.exists());
        let records = directory.path().join("recordings").join("agent-desktop");
        set_recording(true, &records)
            .await
            .expect("enable recording");
        let result = invoke(
            root.clone(),
            "recorded".into(),
            "desktop_wait".into(),
            json!({"ms": 1}),
            false,
        )
        .await
        .expect("recorded wait");
        assert_eq!(result["isError"], false);
        let run = std::fs::read_dir(&records)
            .expect("records")
            .next()
            .expect("run")
            .expect("entry")
            .path();
        let before = std::fs::read(run.join("trace.jsonl")).expect("trace");
        assert!(!before.is_empty());
        set_recording(false, &records)
            .await
            .expect("disable recording");
        invoke(
            root.clone(),
            "not-recorded".into(),
            "desktop_wait".into(),
            json!({"ms": 1}),
            false,
        )
        .await
        .expect("unrecorded wait");
        assert_eq!(
            std::fs::read(run.join("trace.jsonl")).expect("unchanged trace"),
            before
        );
        let action_root = root.clone();
        let action = tokio::spawn(async move {
            invoke(
                action_root,
                "cancel-live".into(),
                "desktop_wait".into(),
                json!({"ms": 10000}),
                false,
            )
            .await
        });
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(cancel("cancel-live"));
        let result = tokio::time::timeout(Duration::from_secs(2), action)
            .await
            .expect("bounded cancellation")
            .expect("task");
        assert!(result.expect_err("cancelled").contains("cancelled"));
        let result = invoke(
            root.clone(),
            "after-cancel".into(),
            "desktop_wait".into(),
            json!({"ms": 1}),
            false,
        )
        .await
        .expect("usable after cancellation");
        assert_eq!(result["isError"], false);
        {
            let mut state = STATE.lock().await;
            state
                .runtime
                .as_mut()
                .expect("running transport")
                .service
                .close()
                .await
                .expect("simulate transport close");
        }
        let recovered = invoke(
            root.clone(),
            "after-transport-close".into(),
            "desktop_wait".into(),
            json!({"ms": 1}),
            false,
        )
        .await
        .expect("recover after disconnect");
        assert_eq!(recovered["isError"], false);
        shutdown().await.expect("shutdown");
        assert!(!list_tools(root.clone()).await.expect("restart").is_empty());
        remove(&root).await.expect("remove");
        assert!(!root.exists());
    }
}
