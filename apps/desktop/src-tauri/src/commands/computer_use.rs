// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 电脑操作原生命令。
//!
//! 命令层只做参数透传与执行 id 绑定；下载、加载、调用与取消都在
//! `core::computer_use` 里完成，避免生命周期管理散落到 Tauri 入口。

use serde_json::Value;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Runtime, State};

use crate::core::computer_use::{
    agent_desktop, backend::DriverId, driver, foreground, http::HttpWheelFetcher, manifest,
    storage::DriverStorage,
};
use crate::core::system::paths::{app_directory_path, AppDirectory};

const USER_AGENT: &str = concat!("TouchAI/", env!("CARGO_PKG_VERSION"));
const COMPUTER_USE_CALL_TIMEOUT: Duration = Duration::from_secs(30);
static INPUT_QUEUE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static PENDING_ACTIONS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(64);

fn call_timeout(tool: &str) -> Duration {
    match tool {
        "run_steps" => Duration::from_secs(65),
        "run_script" | "replay_trajectory" | "install_ffmpeg" => Duration::from_secs(125),
        _ => COMPUTER_USE_CALL_TIMEOUT,
    }
}

#[tauri::command]
pub async fn computer_use_list_tools(
    driver: Option<DriverId>,
    storage: State<'_, DriverStorage>,
) -> Result<Vec<Value>, String> {
    let root = storage.read().await?;
    driver.unwrap_or_default().list_tools(root.clone()).await
}

/// 当前驱动状态：是否已安装、版本、ABI、运行时元数据。
#[tauri::command]
pub async fn computer_use_status(
    driver: Option<DriverId>,
    storage: State<'_, DriverStorage>,
) -> Result<driver::DriverStatus, String> {
    let root = storage.read().await?;
    driver.unwrap_or_default().status(root.clone()).await
}

#[tauri::command]
pub async fn computer_use_driver_directory(
    storage: State<'_, DriverStorage>,
) -> Result<String, String> {
    Ok(storage.location().await?.display().to_string())
}

#[tauri::command]
pub async fn computer_use_set_driver_directory(
    directory: std::path::PathBuf,
    storage: State<'_, DriverStorage>,
) -> Result<String, String> {
    storage
        .relocate(directory)
        .await
        .map(|path| path.display().to_string())
        .map_err(|error| {
            if error.starts_with("computer_use_storage_") {
                error
            } else {
                log::warn!("Driver relocation failed: {error}");
                "computer_use_storage_failed".into()
            }
        })
}

/// Show the screen-edge glow while a mutating desktop action runs.
#[tauri::command]
pub fn computer_use_glow_pulse<R: Runtime>(
    app: AppHandle<R>,
    pointer: Option<crate::core::window::computer_use_glow::PointerPosition>,
    activity_id: Option<String>,
) -> Result<(), String> {
    crate::core::window::computer_use_glow::pulse(&app, pointer, activity_id.as_deref())
}

#[tauri::command]
pub fn computer_use_cursor_position<R: Runtime>(
    app: AppHandle<R>,
) -> Result<tauri::PhysicalPosition<f64>, String> {
    app.cursor_position().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn computer_use_glow_set_active<R: Runtime>(
    app: AppHandle<R>,
    activity_id: String,
    active: bool,
    locale: Option<String>,
) -> Result<(), String> {
    crate::core::window::computer_use_glow::set_active(
        &app,
        &activity_id,
        active,
        locale.as_deref(),
    )?;
    if !active {
        tauri::async_runtime::spawn(async move {
            driver::end_activity(&activity_id);
            if let Err(error) = agent_desktop::end_activity(&activity_id).await {
                log::warn!("Failed to release desktop session: {error}");
            }
        });
    }
    Ok(())
}

#[tauri::command]
pub fn computer_use_glow_snapshot<R: Runtime>(
    app: AppHandle<R>,
) -> Result<crate::core::window::computer_use_glow::PulsePayload, String> {
    crate::core::window::computer_use_glow::snapshot(&app)
}

/// 下载（如需要）并加载驱动运行时。重复调用是幂等的。
#[tauri::command]
pub async fn computer_use_prepare(
    driver: Option<DriverId>,
    storage: State<'_, DriverStorage>,
) -> Result<driver::DriverStatus, String> {
    let root = storage.read().await?;
    let fetcher = HttpWheelFetcher::new(USER_AGENT)?;
    driver
        .unwrap_or_default()
        .prepare(root.clone(), &fetcher)
        .await
}

/// 调用一个驱动工具。`execution_id` 由调用方生成，用于取消。
#[tauri::command]
pub async fn computer_use_invoke<R: Runtime>(
    app: AppHandle<R>,
    execution_id: String,
    tool: String,
    arguments: Value,
    full_access: Option<bool>,
    driver: Option<DriverId>,
    allow_foreground: Option<bool>,
    activity_id: Option<String>,
    cursor_visible: Option<bool>,
    storage: State<'_, DriverStorage>,
) -> Result<Value, String> {
    let _pending = PENDING_ACTIONS
        .try_acquire()
        .map_err(|_| "too many pending desktop actions")?;
    let mut cancellation = activity_id
        .as_deref()
        .map(|id| crate::core::window::computer_use_glow::cancellation(&app, id))
        .transpose()?;
    let selected = driver.unwrap_or_default();
    let read_only = if selected == DriverId::AgentDesktop {
        agent_desktop::is_read_only(&tool)
    } else {
        tool.starts_with("get_")
            || tool.starts_with("list_")
            || matches!(
                tool.as_str(),
                "check_permissions"
                    | "health_report"
                    | "verify_state"
                    | "parse_visual_regions"
                    | "zoom"
            )
    };
    let wait_cancelled = async {
        if let Some(receiver) = cancellation.as_mut() {
            if !*receiver.borrow() {
                let _ = receiver.changed().await;
            }
        } else {
            std::future::pending::<()>().await;
        }
    };
    tokio::pin!(wait_cancelled);
    let _input = if read_only {
        None
    } else {
        Some(tokio::select! {
            biased;
            _ = &mut wait_cancelled => return Err("computer use cancelled before execution".into()),
            permit = INPUT_QUEUE.lock() => permit,
        })
    };
    let foreground_operation = if foreground::uses_foreground(
        selected,
        &tool,
        &arguments,
        allow_foreground.unwrap_or(false),
    ) {
        Some(
            crate::core::window::computer_use_glow::ForegroundOperation::begin(
                &app,
                activity_id.as_deref(),
                &execution_id,
            )?,
        )
    } else {
        None
    };
    let feedback_id = foreground_operation
        .as_ref()
        .map(|operation| operation.activity_id());
    let activity_cancelled = activity_id
        .as_deref()
        .or(feedback_id)
        .map(|id| crate::core::window::computer_use_glow::cancellation(&app, id))
        .transpose()?;
    let scope = activity_id.clone();
    let execution = execution_id.clone();
    let progress = foreground_operation.is_some() && cursor_visible == Some(true);
    let report_pointer = |pointer| {
        if let Err(error) =
            crate::core::window::computer_use_glow::pulse(&app, Some(pointer), feedback_id)
        {
            log::warn!("Failed to display desktop target: {error}");
        }
    };
    let operation = async {
        let root = storage.read().await?;
        if selected == DriverId::AgentDesktop {
            return agent_desktop::invoke_cancellable(
                selected.root(&root),
                execution_id,
                tool,
                arguments,
                allow_foreground.unwrap_or(false),
                scope.as_deref(),
                activity_cancelled,
                if cursor_visible == Some(true) && foreground_operation.is_some() {
                    Some(&report_pointer)
                } else {
                    None
                },
            )
            .await;
        }
        driver::restore_installed(selected.root(&root)).await?;
        let result = tauri::async_runtime::spawn_blocking(move || {
            invoke_blocking(
                execution_id,
                tool,
                arguments,
                full_access.unwrap_or(false),
                activity_cancelled,
            )
        })
        .await
        .map_err(|error| format!("computer use invoke task failed: {error}"))?;

        match result {
            Ok(value) => Ok(value),
            Err(failure) => {
                // The command response must not wait for a driver that may already
                // be wedged. Queue cancellation after the timeout has been handed
                // back to the caller instead of creating another thread inline.
                if let Some(call_id) = failure.cancel_id {
                    let _ = tauri::async_runtime::spawn_blocking(move || {
                        driver::cancel(call_id);
                    });
                }
                Err(failure.message)
            }
        }
    };
    tokio::pin!(operation);
    let mut tick = tokio::time::interval(Duration::from_millis(80));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut previous = None;
    loop {
        tokio::select! {
            biased;
            _ = &mut wait_cancelled => {
                driver::cancel_execution(&execution);
                agent_desktop::cancel(&execution);
                let _ = (&mut operation).await;
                return Err("computer use cancelled".into());
            }
            result = &mut operation => {
                if progress { publish_system_pointer(&app, feedback_id, &mut previous); }
                return result;
            }
            _ = tick.tick(), if progress => publish_system_pointer(&app, feedback_id, &mut previous),
        }
    }
}

fn publish_system_pointer<R: Runtime>(
    app: &AppHandle<R>,
    activity_id: Option<&str>,
    previous: &mut Option<crate::core::window::computer_use_glow::PointerPosition>,
) {
    if let Ok(position) = app.cursor_position() {
        let pointer = crate::core::window::computer_use_glow::PointerPosition {
            x: position.x,
            y: position.y,
        };
        if *previous != Some(pointer) {
            *previous = Some(pointer);
            if let Err(error) =
                crate::core::window::computer_use_glow::pulse(app, Some(pointer), activity_id)
            {
                log::warn!("Failed to display desktop pointer: {error}");
            }
        }
    }
}

/// Run one driver call without relying on the async runtime to time out a
/// missing native callback.
///
/// The driver invokes the completion callback on its own thread and has been
/// observed to start `launch_app` without ever completing the callback. A
/// Tokio timer did not fire on that path, so the call runs on the Tauri
/// blocking pool and completion is polled without creating a second thread.
fn invoke_blocking(
    execution_id: String,
    tool: String,
    arguments: Value,
    full_access: bool,
    cancellation: Option<tokio::sync::watch::Receiver<bool>>,
) -> Result<Value, InvokeFailure> {
    let timeout = call_timeout(&tool);
    driver::begin_execution(&execution_id).map_err(InvokeFailure::without_cancel)?;
    if cancellation
        .as_ref()
        .is_some_and(|receiver| *receiver.borrow() || receiver.has_changed().is_err())
    {
        driver::release_execution(&execution_id);
        return Err(InvokeFailure::without_cancel(
            "computer use cancelled before execution",
        ));
    }
    let worker_execution_id = execution_id.clone();
    let ending_session = (full_access && tool == "end_session").then(|| arguments.clone());
    let pending = wait_for_worker(
        move || {
            let pending = driver::invoke_with_access(&tool, &arguments, full_access)?;
            if let Err(error) = driver::bind_execution(&worker_execution_id, pending.id) {
                driver::cancel(pending.id);
                return Err(error);
            }
            Ok(pending)
        },
        timeout,
        "computer use invoke did not start before the timeout",
    )
    .and_then(|result| result)
    .map_err(|message| {
        driver::release_execution(&execution_id);
        InvokeFailure::without_cancel(message)
    })?;
    let call_id = pending.id;
    let mut receiver = pending.receiver;
    let outcome = wait_for_completion(
        &mut receiver,
        timeout,
        "computer use call timed out before the driver confirmed it; \
         the action may have taken effect, observe the target before retrying",
    );
    driver::release_execution(&execution_id);
    if let (Some(arguments), Ok(Ok(envelope))) = (ending_session, &outcome) {
        if envelope["isError"].as_bool() != Some(true) {
            driver::end_trusted_session(&arguments);
        }
    }

    match outcome {
        Ok(envelope) => envelope.map_err(|error| InvokeFailure::without_cancel(error.to_string())),
        Err(message) => Err(InvokeFailure {
            message,
            cancel_id: Some(call_id),
        }),
    }
}

struct InvokeFailure {
    message: String,
    cancel_id: Option<u64>,
}

impl InvokeFailure {
    fn without_cancel(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            cancel_id: None,
        }
    }
}

/// Poll the completion channel so a timeout does not depend on creating
/// another native thread while the driver is launching an application.
fn wait_for_completion<T>(
    receiver: &mut tokio::sync::oneshot::Receiver<T>,
    timeout: Duration,
    timeout_message: &'static str,
) -> Result<T, String> {
    let deadline = Instant::now() + timeout;
    loop {
        match receiver.try_recv() {
            Ok(value) => return Ok(value),
            Err(tokio::sync::oneshot::error::TryRecvError::Closed) => {
                return Err("computer use call was cancelled".to_string())
            }
            Err(tokio::sync::oneshot::error::TryRecvError::Empty) => {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return Err(timeout_message.to_string());
                }
                thread::sleep(remaining.min(Duration::from_millis(10)));
            }
        }
    }
}

fn wait_for_worker<T: Send + 'static>(
    task: impl FnOnce() -> T + Send + 'static,
    timeout: Duration,
    timeout_message: &'static str,
) -> Result<T, String> {
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let _ = sender.send(task());
    });
    receiver
        .recv_timeout(timeout)
        .map_err(|_| timeout_message.to_string())
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use crate::core::computer_use::abi::AbiError;

    use super::*;

    #[tokio::test]
    async fn user_given_a_relative_recording_location_when_enabling_then_is_refused_before_recording(
    ) {
        let error = recording_directory(Some("relative/recordings".into()), DriverId::Cua)
            .expect_err("relative path must not start recording");
        assert!(error.contains("absolute"));
    }

    #[test]
    fn user_given_bounded_automation_when_running_then_has_time_for_the_driver_budget() {
        assert_eq!(call_timeout("run_steps"), Duration::from_secs(65));
        assert_eq!(call_timeout("run_script"), Duration::from_secs(125));
        assert_eq!(call_timeout("click"), Duration::from_secs(30));
    }

    #[test]
    fn user_gets_a_timeout_when_a_native_call_never_completes() {
        let started_at = Instant::now();

        let result = wait_for_worker(
            || thread::sleep(Duration::from_millis(500)),
            Duration::from_millis(50),
            "native call timed out",
        );

        assert_eq!(result, Err("native call timed out".to_string()));
        assert!(started_at.elapsed() < Duration::from_millis(400));
    }

    #[test]
    fn user_gets_the_result_when_a_native_call_completes() {
        let result = wait_for_worker(|| 42, Duration::from_secs(1), "native call timed out");

        assert_eq!(result, Ok(42));
    }

    #[test]
    fn user_gets_a_timeout_when_the_completion_callback_never_fires() {
        let (_sender, mut receiver) = tokio::sync::oneshot::channel::<Result<Value, AbiError>>();
        let started_at = Instant::now();

        let result = wait_for_completion(
            &mut receiver,
            Duration::from_millis(50),
            "computer use call timed out",
        );

        assert_eq!(
            result.err(),
            Some("computer use call timed out".to_string())
        );
        assert!(started_at.elapsed() < Duration::from_millis(400));
    }

    #[test]
    fn user_gets_the_result_when_the_completion_callback_fires() {
        let (sender, mut receiver) = tokio::sync::oneshot::channel::<Result<Value, AbiError>>();
        sender
            .send(Ok(serde_json::json!({ "ok": true })))
            .expect("receiver must stay open");

        let result = wait_for_completion(
            &mut receiver,
            Duration::from_secs(1),
            "computer use call timed out",
        )
        .expect("completion should arrive");

        assert_eq!(result.expect("driver result")["ok"], true);
    }
}

/// 取消一次在途调用；返回是否找到并发出取消信号。
#[tauri::command]
pub fn computer_use_cancel(execution_id: String) -> bool {
    let cua = driver::cancel_execution(&execution_id);
    agent_desktop::cancel(&execution_id) || cua
}

#[tauri::command]
pub fn computer_use_cancel_all<R: Runtime>(app: AppHandle<R>) -> usize {
    crate::core::window::computer_use_glow::stop_all(&app).unwrap_or_else(|error| {
        log::warn!("Failed to stop computer-use feedback: {error}");
        driver::cancel_all() + agent_desktop::cancel_all()
    })
}

/// 把设置页的选项下发给驱动（截图边长、操作光标）。
#[tauri::command]
pub async fn computer_use_apply_settings(
    max_image_dimension: Option<u32>,
    cursor_visible: Option<bool>,
    storage: State<'_, DriverStorage>,
) -> Result<Vec<String>, String> {
    let _lease = storage.read().await?;
    Ok(driver::apply_settings(max_image_dimension, cursor_visible).await)
}

#[tauri::command]
pub async fn computer_use_set_recording(
    enabled: bool,
    output_dir: Option<std::path::PathBuf>,
    driver: Option<DriverId>,
    storage: State<'_, DriverStorage>,
) -> Result<bool, String> {
    let selected = driver.unwrap_or_default();
    let dir = recording_directory(output_dir, selected)?;
    let root = storage.read().await?;
    if enabled {
        let status = match selected {
            DriverId::Cua => driver::restore_installed(selected.root(&root)).await?,
            DriverId::AgentDesktop => selected.status(root.clone()).await?,
        };
        if !status.installed {
            return Err("the computer use driver is not installed".into());
        }
    }
    match selected {
        DriverId::Cua => driver::set_recording(enabled, &dir).await?,
        DriverId::AgentDesktop => agent_desktop::set_recording(enabled, &dir).await?,
    }
    Ok(true)
}

fn recording_directory(
    output_dir: Option<std::path::PathBuf>,
    selected: DriverId,
) -> Result<std::path::PathBuf, String> {
    match output_dir {
        Some(dir) if dir.is_absolute() => Ok(dir),
        Some(_) => Err("recording location must be an absolute directory".into()),
        None => Ok(app_directory_path(AppDirectory::Cache)?
            .join("computer-use-trajectories")
            .join(selected.name())),
    }
}

/// 检查镜像上是否有更新的驱动版本。
#[tauri::command]
pub async fn computer_use_check_update(driver: Option<DriverId>) -> driver::UpdateInfo {
    if driver == Some(DriverId::AgentDesktop) {
        return agent_desktop::check_update().await;
    }
    match HttpWheelFetcher::new(USER_AGENT) {
        Ok(fetcher) => driver::check_update(&fetcher).await,
        Err(error) => driver::UpdateInfo {
            current: manifest::MANIFEST.version.to_string(),
            latest: None,
            update_available: false,
            error: Some(error),
        },
    }
}

/// 卸载驱动：释放运行时并删除已安装的全部版本。
#[tauri::command]
pub async fn computer_use_remove<R: Runtime>(
    app: AppHandle<R>,
    driver: Option<DriverId>,
    storage: State<'_, DriverStorage>,
) -> Result<bool, String> {
    crate::core::window::computer_use_glow::clear(&app)?;
    let root = storage.exclusive().await?;
    driver.unwrap_or_default().remove(&root).await?;
    Ok(true)
}

/// 释放运行时。会话结束或用户关闭电脑操作时调用。
#[tauri::command]
pub async fn computer_use_shutdown<R: Runtime>(
    app: AppHandle<R>,
    storage: State<'_, DriverStorage>,
) -> Result<(), String> {
    let _lease = storage.exclusive().await?;
    if let Err(error) = crate::core::window::computer_use_glow::clear(&app) {
        log::warn!("Failed to clear computer-use feedback: {error}");
    }
    driver::shutdown();
    agent_desktop::shutdown().await
}
