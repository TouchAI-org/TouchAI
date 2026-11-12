// Copyright (c) 2026. 千诚. Licensed under GPL v3.

// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 运行时生命周期：确保已安装、加载 ABI、暴露状态与调用入口。
//!
//! 只持有一个运行时实例；重复调用返回同一句柄，避免多个实例抢同一桌面输入。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::Value;

pub mod abi;
pub mod manifest;

use self::abi::{AbiError, AbiLibrary, Driver, PendingCall};
use self::manifest::MANIFEST;
use super::backend::{DriverStatus, UpdateInfo};
use super::http;
use super::manifest::{artifact, is_publishable, Artifact, Transport};
use super::provision::{
    active_install, confirm_version, ensure_installed, installed_binary, installed_size,
    InstallLayout, ProvisionError, WheelFetcher,
};

use super::recording::create_recording_directory;

static RUNTIME: OnceLock<Mutex<Option<Arc<Driver>>>> = OnceLock::new();
static RUNTIME_STATUS: OnceLock<Mutex<Option<DriverStatus>>> = OnceLock::new();
static LOADING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn runtime() -> &'static Mutex<Option<Arc<Driver>>> {
    RUNTIME.get_or_init(|| Mutex::new(None))
}

fn runtime_status() -> &'static Mutex<Option<DriverStatus>> {
    RUNTIME_STATUS.get_or_init(|| Mutex::new(None))
}

fn cached_status() -> Option<DriverStatus> {
    runtime_status().lock().ok().and_then(|guard| guard.clone())
}

fn cache_status(status: &DriverStatus) {
    if let Ok(mut guard) = runtime_status().lock() {
        *guard = Some(status.clone());
    }
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
    let _loading = LOADING.lock().await;
    if let Some(driver) = current() {
        return Ok(cached_status().unwrap_or_else(|| status_of(&driver)));
    }

    let artifact = artifact(&MANIFEST).ok_or_else(|| format!("no driver artifact for {target}"))?;
    if !is_publishable(artifact) {
        return Err(format!("computer use is not available for {target} yet"));
    }
    if artifact.transport != Transport::InProcess {
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
        &MANIFEST.mirrors,
    )
    .await
    .map_err(|error: ProvisionError| error.to_string())?;

    // 内置形态只需要同目录下的 dll，wheel 里就是它。
    let library_path = installed.binary().to_path_buf();

    load_runtime(library_path, MANIFEST.version).await
}

/// Install a newer published release and switch to it only after it loads.
///
/// The running release stays untouched until the candidate has downloaded,
/// matched the digest from the package indexes, and answered the tool catalog.
/// Any failure leaves the previous installation and `current.json` unchanged.
pub async fn upgrade<F: WheelFetcher>(
    root: PathBuf,
    fetcher: &F,
    version: &str,
    release: http::WheelRelease,
) -> Result<DriverStatus, String> {
    let _loading = LOADING.lock().await;
    let artifact = artifact(&MANIFEST).ok_or("unsupported driver platform")?;
    if !is_publishable(artifact) {
        return Err("computer use is not available for this platform".into());
    }
    let filename = manifest::release_filename(artifact, version)?;
    let package_path = release.package_path;
    if !package_path.contains(version) || !package_path.contains(&filename) {
        return Err("the package index returned an unrelated release".into());
    }
    let candidate = Artifact {
        target: artifact.target,
        package_path: &package_path,
        sha256: &release.sha256,
        size: 0,
        entry: artifact.entry,
        transport: artifact.transport,
        binary_sha256: "",
        filename: artifact.filename,
        helpers: artifact.helpers.clone(),
    };
    let layout = InstallLayout::new(&root);
    let installed = ensure_installed(fetcher, &layout, version, &candidate, &MANIFEST.mirrors)
        .await
        .map_err(|error: ProvisionError| error.to_string())?;
    shutdown();
    let binary = installed.binary().to_path_buf();
    match load_runtime(binary, version).await {
        Ok(status) => Ok(status),
        Err(error) => {
            shutdown();
            if let Some((previous, binary)) =
                active_install(&layout).map_err(|error| error.to_string())?
            {
                if previous != version {
                    if let Ok(restored) = load_runtime(binary, &previous).await {
                        log::warn!(
                            "Driver {version} failed to start; restored {previous}: {error}"
                        );
                        return Ok(restored);
                    }
                }
            }
            Err(error)
        }
    }
}

pub async fn restore_installed(root: PathBuf) -> Result<DriverStatus, String> {
    let _loading = LOADING.lock().await;
    if let Some(driver) = current() {
        return Ok(cached_status().unwrap_or_else(|| status_of(&driver)));
    }
    let layout = InstallLayout::new(root);
    if let Some((version, binary)) = active_install(&layout).map_err(|error| error.to_string())? {
        return load_runtime(binary, &version).await;
    }
    // Installs made before activation was recorded still live under the pinned
    // manifest version, so fall back to it instead of reporting "missing".
    let Some(artifact) = artifact(&MANIFEST) else {
        return Ok(DriverStatus::missing(None));
    };
    let Some(binary) =
        installed_binary(&layout, MANIFEST.version, artifact).map_err(|error| error.to_string())?
    else {
        return Ok(DriverStatus::missing(None));
    };
    load_runtime(binary, MANIFEST.version).await
}

pub async fn installed_status(root: PathBuf) -> Result<DriverStatus, String> {
    if current().is_some() {
        return Ok(status());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let layout = InstallLayout::new(root);
        if let Some((version, binary)) =
            active_install(&layout).map_err(|error| error.to_string())?
        {
            return Ok(DriverStatus {
                installed: true,
                binary: Some(binary.display().to_string()),
                driver_version: Some(version),
                installed_size_bytes: installed_size(&binary),
                abi_version: None,
                metadata: None,
                error: None,
            });
        }
        let Some(artifact) = artifact(&MANIFEST) else {
            return Ok(DriverStatus::missing(None));
        };
        let Some(binary) = installed_binary(&layout, MANIFEST.version, artifact)
            .map_err(|error| error.to_string())?
        else {
            return Ok(DriverStatus::missing(None));
        };
        Ok(DriverStatus {
            installed: true,
            binary: Some(binary.display().to_string()),
            driver_version: Some(MANIFEST.version.to_string()),
            installed_size_bytes: installed_size(&binary),
            abi_version: None,
            metadata: None,
            error: None,
        })
    })
    .await
    .map_err(|error| format!("computer use installation check failed: {error}"))?
}

async fn load_runtime(library_path: PathBuf, version: &str) -> Result<DriverStatus, String> {
    let version = version.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let root = library_path
            .parent()
            .and_then(|directory| directory.parent())
            .ok_or("invalid driver installation path")?
            .to_path_buf();
        let status = load_library(library_path, &version)?;
        let activated = (|| {
            if list_tools()?.is_empty() {
                return Err("the driver returned no tools".to_string());
            }
            confirm_version(&InstallLayout::new(root), &version).map_err(|error| error.to_string())
        })();
        if let Err(error) = activated {
            shutdown();
            return Err(error);
        }
        Ok(status)
    })
    .await
    .map_err(|error| format!("computer use loading failed: {error}"))?
}

fn load_library(library_path: PathBuf, version: &str) -> Result<DriverStatus, String> {
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
        .create(
            &serde_json::json!({
                "authorization": {
                    "allowed_modes": ["standard", "unrestricted"],
                    "compatibility_mode": "standard",
                    "unrestricted_acknowledged": true,
                    "max_session_ttl_seconds": 86400,
                    "max_idle_ttl_seconds": 3600
                }
            })
            .to_string(),
        )
        .map_err(|error: AbiError| error.to_string())?;
    if !driver.sync_state() {
        return Err("the driver runtime refused to start".to_string());
    }

    let mut status = status_of(&driver);
    status.driver_version = Some(version.to_string());
    status.abi_version = Some(abi);
    status.installed = true;
    status.installed_size_bytes = installed_size(&library_path);
    status.binary = Some(library_path.display().to_string());

    cache_status(&status);
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
        installed_size_bytes: None,
        metadata,
        error: None,
    }
}

pub fn invoke(tool: &str, arguments: &Value) -> Result<PendingCall, String> {
    invoke_with_access(tool, arguments, false)
}

pub fn invoke_with_access(
    tool: &str,
    arguments: &Value,
    full_access: bool,
) -> Result<PendingCall, String> {
    let driver = current().ok_or_else(|| "the computer use driver is not loaded".to_string())?;
    let tools = driver.list_tools().map_err(|error| error.to_string())?;
    if !is_tool_registered(tool, tools) {
        return Err(format!("computer use tool is not allowed: {tool}"));
    }
    driver
        .invoke(tool, arguments, full_access)
        .map_err(|error| error.to_string())
}

pub fn end_trusted_session(arguments: &Value) {
    if let Some(driver) = current() {
        driver.end_session(arguments);
    }
}

pub fn end_activity(activity_id: &str) {
    if let Some(driver) = current() {
        driver.end_activity(activity_id);
    }
}

pub fn list_tools() -> Result<Vec<Value>, String> {
    let Some(driver) = current() else {
        return Ok(Vec::new());
    };
    driver
        .list_tools()
        .cloned()
        .map_err(|error| error.to_string())
}

fn is_tool_registered(tool: &str, tools: &[Value]) -> bool {
    !tool.is_empty()
        && tools
            .iter()
            .any(|entry| entry["name"].as_str() == Some(tool))
}

#[derive(Default)]
struct Execution {
    call_id: Option<u64>,
    cancelled: bool,
}

static INFLIGHT: OnceLock<Mutex<HashMap<String, Execution>>> = OnceLock::new();

fn inflight() -> &'static Mutex<HashMap<String, Execution>> {
    INFLIGHT.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn begin_execution(execution_id: &str) -> Result<(), String> {
    let mut guard = inflight()
        .lock()
        .map_err(|_| "computer use execution registry poisoned".to_string())?;
    if guard.contains_key(execution_id) {
        return Err("duplicate computer use execution id".to_string());
    }
    guard.insert(execution_id.to_string(), Execution::default());
    Ok(())
}

/// Bind an ABI call id to the execution id the frontend can cancel.
pub fn bind_execution(execution_id: &str, call_id: u64) -> Result<(), String> {
    let cancelled = {
        let mut guard = inflight()
            .lock()
            .map_err(|_| "computer use execution registry poisoned".to_string())?;
        let entry = guard
            .get_mut(execution_id)
            .ok_or_else(|| "computer use execution no longer registered".to_string())?;
        entry.call_id = Some(call_id);
        entry.cancelled
    };
    if cancelled {
        cancel(call_id);
        return Err("computer use call was cancelled before it started".to_string());
    }
    Ok(())
}

/// Drop the binding once the call settles.
pub fn release_execution(execution_id: &str) {
    if let Ok(mut guard) = inflight().lock() {
        guard.remove(execution_id);
    }
}

#[cfg(test)]
mod tests {
    use super::is_tool_registered;
    use super::{begin_execution, bind_execution, cancel_execution, release_execution};

    #[cfg(windows)]
    #[tokio::test]
    async fn user_given_a_loaded_only_driver_when_removing_then_it_becomes_unavailable_without_unloading_code(
    ) {
        let Ok(source) = std::env::var("TOUCHAI_TEST_CUA_ROOT") else {
            return;
        };
        let fixture = tempfile::tempdir().expect("isolated install");
        let root = fixture.path().join("computer-use");
        let version = root.join(super::MANIFEST.version);
        std::fs::create_dir_all(&version).expect("version directory");
        let source = std::path::Path::new(&source).join(super::MANIFEST.version);
        for filename in ["cua_driver_sdk.dll", "install.json"] {
            std::fs::copy(source.join(filename), version.join(filename)).expect("copy fixture");
        }
        let binary = version.join("cua_driver_sdk.dll");
        let library = unsafe { libloading::Library::new(&binary) }.expect("load real DLL");
        assert!(
            super::installed_status(root.clone())
                .await
                .expect("installed")
                .installed
        );

        super::remove_installed(&root)
            .await
            .expect("remove loaded driver");

        assert!(
            !super::installed_status(root.clone())
                .await
                .expect("removed")
                .installed
        );
        assert!(
            !super::restore_installed(root.clone())
                .await
                .expect("no restoration")
                .installed
        );
        assert!(super::list_tools().expect("no tools").is_empty());
        assert!(
            unsafe { library.get::<unsafe extern "C" fn()>(b"cua_driver_create_v1\0") }.is_ok()
        );
        assert!(super::super::storage::cleanup_removed_installations(&root).is_err());

        std::fs::create_dir_all(&version).expect("reinstall directory");
        for filename in ["cua_driver_sdk.dll", "install.json"] {
            std::fs::copy(source.join(filename), version.join(filename))
                .expect("reinstall fixture");
        }
        assert!(
            super::installed_status(root.clone())
                .await
                .expect("reinstalled")
                .installed
        );
        drop(library);
        super::super::storage::cleanup_removed_installations(&root)
            .expect("cleanup after library release");
        assert_eq!(
            std::fs::read_dir(root.with_extension("removed"))
                .expect("retired directory")
                .count(),
            0
        );
        assert!(
            super::installed_status(root)
                .await
                .expect("new install preserved")
                .installed
        );
    }

    #[tokio::test]
    async fn user_given_an_installed_driver_when_removing_then_preserves_other_drivers_and_recordings(
    ) {
        let fixture = tempfile::tempdir().expect("isolated profile");
        let root = fixture.path().join("computer-use");
        std::fs::create_dir_all(&root).expect("install directory");
        std::fs::write(root.join("driver"), "driver").expect("driver");
        let other = fixture.path().join("agent-desktop");
        let recording = fixture.path().join("recording.json");
        std::fs::write(&other, "other driver").expect("other install");
        std::fs::write(&recording, "recording").expect("recording");
        super::remove_installed(&root)
            .await
            .expect("remove install");
        super::remove_installed(&root)
            .await
            .expect("already removed");
        super::super::storage::cleanup_removed_installations(&root).expect("cleanup");
        assert!(!root.exists());
        assert_eq!(
            std::fs::read_to_string(other).expect("preserved other"),
            "other driver"
        );
        assert_eq!(
            std::fs::read_to_string(recording).expect("preserved recording"),
            "recording"
        );
    }

    #[tokio::test]
    async fn user_given_a_blocked_removal_location_when_removing_then_keeps_the_installation_and_can_retry(
    ) {
        let fixture = tempfile::tempdir().expect("isolated profile");
        let root = fixture.path().join("computer-use");
        std::fs::create_dir_all(&root).expect("install directory");
        std::fs::write(root.join("driver"), "driver").expect("driver");
        let blocked = root.with_extension("removed");
        std::fs::write(&blocked, "blocked").expect("blocked location");
        assert!(super::remove_installed(&root)
            .await
            .expect_err("remove failure")
            .contains("retirement"));
        assert_eq!(
            std::fs::read_to_string(root.join("driver")).expect("preserved install"),
            "driver"
        );
        std::fs::remove_file(blocked).expect("unblock");
        super::remove_installed(&root).await.expect("retry removal");
        assert!(!root.exists());
    }

    #[tokio::test]
    async fn user_given_an_installed_driver_when_restarting_then_restores_tools_without_installing_again(
    ) {
        let Ok(root) = std::env::var("TOUCHAI_TEST_CUA_ROOT") else {
            return;
        };
        let missing = tempfile::tempdir().expect("missing install fixture");
        let status = super::restore_installed(missing.path().join("absent"))
            .await
            .expect("missing state");
        assert!(!status.installed);
        assert!(!missing.path().join("absent").exists());
        let status = super::installed_status(root.clone().into())
            .await
            .expect("installed status");
        assert!(status.installed);
        assert!(super::current().is_none());
        let status = super::restore_installed(root.into())
            .await
            .expect("restore installed runtime");
        assert!(status.installed);
        assert!(super::list_tools()
            .expect("catalog")
            .iter()
            .any(|tool| tool["name"] == "move_cursor"));
        super::shutdown();
    }

    /// Live upgrade from an empty install to the newest published release.
    ///
    /// Ignored by default: it needs the network and downloads a release wheel.
    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "downloads a release from the package indexes"]
    async fn user_given_a_newer_release_when_upgrading_then_loads_it_and_records_the_version() {
        let fixture = tempfile::tempdir().expect("isolated install");
        let root = fixture.path().join("cua-driver");
        let fetcher = super::super::http::HttpWheelFetcher::new("TouchAI/test").expect("client");
        let manifest = &super::MANIFEST;
        let artifact = super::artifact(manifest).expect("artifact");
        let filename = super::manifest::release_filename(artifact, "0.44.0").expect("name");
        let release = fetcher
            .release(&manifest.mirrors, "0.44.0", &filename)
            .await
            .expect("release");

        let status = super::upgrade(root.clone(), &fetcher, "0.44.0", release)
            .await
            .expect("upgrade");

        assert_eq!(status.driver_version.as_deref(), Some("0.44.0"));
        assert!(status.installed);
        assert!(super::list_tools()
            .expect("catalog")
            .iter()
            .any(|tool| tool["name"] == "move_cursor"));
        let pointer = std::fs::read_to_string(root.join("current.json")).expect("pointer");
        assert!(pointer.contains("0.44.0"));
        super::shutdown();
    }

    #[tokio::test]
    async fn user_given_an_upgraded_install_when_reading_status_then_reports_its_own_version() {
        let fixture = tempfile::tempdir().expect("isolated install");
        let root = fixture.path().join("cua-driver");
        let version = root.join("0.44.0");
        std::fs::create_dir_all(&version).expect("version directory");
        let binary = version.join("cua_driver_sdk.dll");
        std::fs::write(&binary, b"upgraded driver").expect("binary");
        let digest = super::super::provision::sha256_file(&binary).expect("digest");
        std::fs::write(
            version.join("install.json"),
            serde_json::json!({
                "version": "0.44.0",
                "wheel_sha256": "1fba13e3a3f513117ce36e11949150708e25af5b035058cf870d9148f102db0f",
                "binary_sha256": digest,
            })
            .to_string(),
        )
        .expect("record");
        std::fs::write(root.join("current.json"), r#"{"version":"0.44.0"}"#).expect("pointer");

        let status = super::installed_status(root).await.expect("status");

        assert!(status.installed);
        assert_eq!(status.driver_version.as_deref(), Some("0.44.0"));
    }

    #[test]
    fn user_given_starting_call_when_cancelling_then_cancellation_is_remembered_until_binding() {
        let execution_id = "test-cancel-before-binding";
        begin_execution(execution_id).expect("start");
        assert!(cancel_execution(execution_id));
        assert!(bind_execution(execution_id, 99)
            .expect_err("cancelled call")
            .contains("cancelled"));
        release_execution(execution_id);
        assert!(!cancel_execution(execution_id));
    }

    #[test]
    fn user_given_registered_tools_when_invoking_then_can_use_every_driver_tool() {
        for tool in [
            "run_steps",
            "run_script",
            "kill_app",
            "browser_download",
            "future_tool",
        ] {
            assert!(is_tool_registered(
                tool,
                &[serde_json::json!({ "name": tool })]
            ));
        }
    }

    #[test]
    fn user_given_unknown_tools_when_invoking_then_gets_refused() {
        assert!(!is_tool_registered(
            "missing",
            &[serde_json::json!({ "name": "click" })]
        ));
        assert!(!is_tool_registered("", &[]));
    }
}

/// Cancel one in-flight call by execution id.
pub fn cancel_execution(execution_id: &str) -> bool {
    let Ok(mut guard) = inflight().lock() else {
        return false;
    };
    let Some(entry) = guard.get_mut(execution_id) else {
        return false;
    };
    entry.cancelled = true;
    if let Some(call_id) = entry.call_id {
        cancel(call_id);
    }
    true
}

pub fn cancel_all() -> usize {
    let keys = inflight()
        .lock()
        .map(|guard| guard.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    keys.iter().filter(|key| cancel_execution(key)).count()
}

pub fn cancel(id: u64) -> bool {
    current().map(|driver| driver.cancel(id)).unwrap_or(false)
}

/// 会话结束时释放运行时，避免残留输入通道。
pub fn shutdown() {
    if let Ok(mut guard) = runtime().lock() {
        guard.take();
    }
    if let Ok(mut guard) = runtime_status().lock() {
        *guard = None;
    }
}

pub fn status() -> DriverStatus {
    match current() {
        Some(driver) => cached_status().unwrap_or_else(|| status_of(&driver)),
        None => DriverStatus::missing(None),
    }
}

/// Ask the mirrors for the newest published driver version.
///
/// `current` is the installed version, not the pinned manifest one, otherwise an
/// upgraded installation would keep being offered the same release.
pub async fn check_update(fetcher: &http::HttpWheelFetcher, current: String) -> UpdateInfo {
    match fetcher.latest_version(&MANIFEST.mirrors).await {
        Ok(latest) => UpdateInfo {
            update_available: http::compare(&latest, &current) == std::cmp::Ordering::Greater,
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

/// Retire the installation without unloading code still used by native callbacks.
pub async fn remove_installed(root: &std::path::Path) -> Result<(), String> {
    let _loading = LOADING.lock().await;
    let root = root.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        cancel_all();
        shutdown();
        super::storage::retire_installation(&root)
    })
    .await
    .map_err(|error| format!("driver removal task failed: {error}"))?
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
    static RECORDING: tokio::sync::Mutex<Option<(std::sync::Weak<Driver>, PathBuf)>> =
        tokio::sync::Mutex::const_new(None);
    let Some(active) = current() else {
        return Ok(());
    };
    let mut recording = RECORDING.lock().await;
    if enabled
        && recording.as_ref().is_some_and(|(owner, directory)| {
            directory == output_dir
                && owner
                    .upgrade()
                    .is_some_and(|owner| Arc::ptr_eq(&owner, &active))
        })
    {
        return Ok(());
    }

    if !enabled {
        let result = match call_tool("stop_recording", serde_json::json!({})).await {
            Ok(_) => Ok(()),
            // Nothing was recording; treat as already off.
            Err(error) if error.contains("not recording") => Ok(()),
            Err(error) => Err(error),
        };
        if result.is_ok() {
            *recording = None;
        }
        return result;
    }

    let root = output_dir.to_path_buf();
    let directory = tauri::async_runtime::spawn_blocking(move || create_recording_directory(&root))
        .await
        .map_err(|error| format!("recording directory preparation failed: {error}"))??;

    call_tool(
        "start_recording",
        serde_json::json!({ "output_dir": directory.display().to_string() }),
    )
    .await
    .map(|_| ())?;
    *recording = Some((Arc::downgrade(&active), output_dir.to_path_buf()));
    Ok(())
}
