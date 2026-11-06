// Copyright (c) 2026. 千诚. Licensed under GPL v3.

// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 运行时生命周期：确保已安装、加载 ABI、暴露状态与调用入口。
//!
//! 只持有一个运行时实例；重复调用返回同一句柄，避免多个实例抢同一桌面输入。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use serde_json::Value;

use super::abi::{AbiError, AbiLibrary, Driver, PendingCall};
use super::manifest::{artifact, is_publishable, MANIFEST};
use super::provision::{ensure_installed, InstallLayout, ProvisionError, WheelFetcher};

#[derive(Debug, Serialize)]
pub struct DriverStatus {
    pub installed: bool,
    pub binary: Option<String>,
    pub driver_version: Option<String>,
    pub abi_version: Option<String>,
    pub metadata: Option<Value>,
    pub error: Option<String>,
}

impl DriverStatus {
    fn missing(error: Option<String>) -> Self {
        Self {
            installed: false,
            binary: None,
            driver_version: None,
            abi_version: None,
            metadata: None,
            error,
        }
    }
}

static RUNTIME: OnceLock<Mutex<Option<Arc<Driver>>>> = OnceLock::new();

fn runtime() -> &'static Mutex<Option<Arc<Driver>>> {
    RUNTIME.get_or_init(|| Mutex::new(None))
}

pub fn current() -> Option<Arc<Driver>> {
    runtime().lock().ok().and_then(|guard| guard.clone())
}

/// 下载（如需要）并加载运行时。已加载时直接返回状态。
pub async fn ensure_ready<F: WheelFetcher>(
    root: PathBuf,
    fetcher: &F,
    target: &str,
) -> Result<DriverStatus, String> {
    if let Some(driver) = current() {
        return Ok(status_of(&driver));
    }

    let artifact = artifact(&MANIFEST).ok_or_else(|| format!("no driver artifact for {target}"))?;
    if !is_publishable(artifact) {
        return Err(format!("computer use is not available for {target} yet"));
    }
    if artifact.transport != super::manifest::Transport::InProcess {
        return Err(format!(
            "{target} is served by a daemon and is not wired yet"
        ));
    }
    let layout = InstallLayout::new(&root);
    let installed = ensure_installed(
        fetcher,
        &layout,
        MANIFEST.version,
        artifact,
        MANIFEST.mirrors,
    )
    .await
    .map_err(|error: ProvisionError| error.to_string())?;

    // 内置形态只需要同目录下的 dll，wheel 里就是它。
    let library_path = installed.binary().to_path_buf();

    let library = AbiLibrary::open(&library_path).map_err(|error: AbiError| error.to_string())?;
    let abi = AbiLibrary::version(&library_path)
        .map_err(|error: AbiError| error.to_string())?
        .to_string();
    if !library
        .is_compatible(1, 1)
        .map_err(|error: AbiError| error.to_string())?
    {
        return Err(format!(
            "driver ABI {abi} is not compatible with this build"
        ));
    }
    let driver = library
        .create("{}")
        .map_err(|error: AbiError| error.to_string())?;
    if !driver.sync_state() {
        return Err("the driver runtime refused to start".to_string());
    }

    let mut status = status_of(&driver);
    status.abi_version = Some(abi);
    status.installed = true;
    status.binary = Some(library_path.display().to_string());

    *runtime().lock().map_err(|_| "runtime lock poisoned")? = Some(Arc::new(driver));
    Ok(status)
}

fn status_of(driver: &Driver) -> DriverStatus {
    let metadata = driver.metadata().ok();
    DriverStatus {
        installed: true,
        binary: None,
        driver_version: metadata
            .as_ref()
            .and_then(|value| value["driver_version"].as_str())
            .map(str::to_string),
        abi_version: None,
        metadata,
        error: None,
    }
}

pub fn invoke(tool: &str, arguments: &Value) -> Result<PendingCall, String> {
    let driver = current().ok_or_else(|| "the computer use driver is not loaded".to_string())?;
    driver
        .invoke(tool, arguments)
        .map_err(|error| error.to_string())
}

static INFLIGHT: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();

fn inflight() -> &'static Mutex<HashMap<String, u64>> {
    INFLIGHT.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Bind an ABI call id to the execution id the frontend can cancel.
pub fn bind_execution(execution_id: &str, call_id: u64) -> Result<(), String> {
    inflight()
        .lock()
        .map_err(|_| "computer use execution registry poisoned".to_string())?
        .insert(execution_id.to_string(), call_id);
    Ok(())
}

/// Drop the binding once the call settles.
pub fn release_execution(execution_id: &str) {
    if let Ok(mut guard) = inflight().lock() {
        guard.remove(execution_id);
    }
}

/// Cancel one in-flight call by execution id.
pub fn cancel_execution(execution_id: &str) -> bool {
    let call_id = inflight()
        .lock()
        .ok()
        .and_then(|guard| guard.get(execution_id).copied());
    match call_id {
        Some(call_id) => cancel(call_id),
        None => false,
    }
}

pub fn cancel(id: u64) -> bool {
    current().map(|driver| driver.cancel(id)).unwrap_or(false)
}

/// 会话结束时释放运行时，避免残留输入通道。
pub fn shutdown() {
    if let Ok(mut guard) = runtime().lock() {
        guard.take();
    }
}

pub fn status() -> DriverStatus {
    match current() {
        Some(driver) => status_of(&driver),
        None => DriverStatus::missing(None),
    }
}

#[derive(Debug, Serialize)]
pub struct UpdateInfo {
    pub current: String,
    pub latest: Option<String>,
    pub update_available: bool,
    pub error: Option<String>,
}

/// Ask the mirrors for the newest published driver version.
pub async fn check_update(fetcher: &super::http::HttpWheelFetcher) -> UpdateInfo {
    let current = MANIFEST.version.to_string();
    match fetcher.latest_version(MANIFEST.mirrors).await {
        Ok(latest) => UpdateInfo {
            update_available: super::http::compare(&latest, MANIFEST.version)
                == std::cmp::Ordering::Greater,
            latest: Some(latest),
            current,
            error: None,
        },
        Err(error) => UpdateInfo {
            current,
            latest: None,
            update_available: false,
            error: Some(error),
        },
    }
}

/// Release the runtime and delete every installed driver version.
///
/// A still-mapped library cannot be deleted on Windows, so the caller is told
/// to restart instead of silently leaving files behind.
pub fn remove_installed(root: &std::path::Path) -> Result<(), String> {
    shutdown();

    if !root.exists() {
        return Ok(());
    }

    std::fs::remove_dir_all(root).map_err(|error| {
        format!(
            "failed to remove {}: {error}. Restart TouchAI and try again.",
            root.display()
        )
    })
}

async fn call_tool(tool: &str, arguments: Value) -> Result<Value, String> {
    let pending = invoke(tool, &arguments)?;
    let envelope = pending
        .receiver
        .await
        .map_err(|_| "the driver call was cancelled".to_string())?
        .map_err(|error| error.to_string())?;
    if envelope["isError"].as_bool() == Some(true) {
        return Err(format!(
            "{tool}: {}",
            envelope["content"][0]["text"]
                .as_str()
                .unwrap_or("driver error")
        ));
    }
    Ok(match envelope.get("structuredContent") {
        Some(value) if !value.is_null() => value.clone(),
        _ => envelope,
    })
}

/// Push the user-facing settings into the driver.
///
/// Each item is applied independently so one unsupported key does not drop the
/// rest; the caller gets the first error, if any.
pub async fn apply_settings(
    max_image_dimension: Option<u32>,
    cursor_visible: Option<bool>,
) -> Vec<String> {
    let mut errors = Vec::new();

    if let Some(dimension) = max_image_dimension {
        if current().is_some() {
            if let Err(error) = call_tool(
                "set_config",
                serde_json::json!({ "max_image_dimension": dimension }),
            )
            .await
            {
                errors.push(error);
            }
        }
    }

    if let Some(enabled) = cursor_visible {
        if current().is_some() {
            if let Err(error) = call_tool(
                "set_agent_cursor_enabled",
                serde_json::json!({ "enabled": enabled }),
            )
            .await
            {
                errors.push(error);
            }
        }
    }

    errors
}

/// Turn trajectory recording on or off for this runtime.
pub async fn set_recording(enabled: bool, output_dir: &std::path::Path) -> Result<(), String> {
    if current().is_none() {
        return Ok(());
    }

    if !enabled {
        return match call_tool("stop_recording", serde_json::json!({})).await {
            Ok(_) => Ok(()),
            // Nothing was recording; treat as already off.
            Err(error) if error.contains("not recording") => Ok(()),
            Err(error) => Err(error),
        };
    }

    std::fs::create_dir_all(output_dir)
        .map_err(|error| format!("failed to create {}: {error}", output_dir.display()))?;

    call_tool(
        "start_recording",
        serde_json::json!({ "output_dir": output_dir.display().to_string() }),
    )
    .await
    .map(|_| ())
}
