use tauri::State;

use crate::core::browser::{
    process::{default_managed_browser_data_path, discover_installed_browsers},
    types::{
        BrowserActRequest, BrowserActResult, BrowserConnectExistingRequest,
        BrowserConnectExistingResult, BrowserDescriptor, BrowserExistingSession,
        BrowserNavigateRequest, BrowserObservation, BrowserObserveRequest, BrowserStartRequest,
        BrowserStatus, BrowserTabRequest,
    },
    BrowserRuntime,
};

#[tauri::command]
pub fn browser_status(runtime: State<'_, BrowserRuntime>) -> BrowserStatus {
    runtime.status()
}

#[tauri::command]
pub async fn browser_start(
    runtime: State<'_, BrowserRuntime>,
    storage: State<'_, crate::core::storage::StorageRuntime>,
    request: BrowserStartRequest,
) -> Result<BrowserStatus, String> {
    let _storage = storage.access().await;
    runtime.start(request).await
}

#[tauri::command]
pub fn browser_discover_installed() -> Vec<BrowserDescriptor> {
    discover_installed_browsers()
}

#[tauri::command]
pub fn browser_default_data_path() -> Result<String, String> {
    default_managed_browser_data_path().map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn browser_discover_existing(
    runtime: State<'_, BrowserRuntime>,
) -> Result<Vec<BrowserExistingSession>, String> {
    runtime.discover_existing_sessions().await
}

#[tauri::command]
pub async fn browser_connect_existing(
    runtime: State<'_, BrowserRuntime>,
    storage: State<'_, crate::core::storage::StorageRuntime>,
    request: BrowserConnectExistingRequest,
) -> Result<BrowserConnectExistingResult, String> {
    let _storage = storage.access().await;
    runtime.connect_existing(request).await
}

#[tauri::command]
pub fn browser_stop(runtime: State<'_, BrowserRuntime>) -> BrowserStatus {
    runtime.stop()
}

#[tauri::command]
pub async fn browser_navigate(
    runtime: State<'_, BrowserRuntime>,
    storage: State<'_, crate::core::storage::StorageRuntime>,
    request: BrowserNavigateRequest,
) -> Result<BrowserStatus, String> {
    let _storage = storage.access().await;
    runtime.navigate(request).await
}

#[tauri::command]
pub async fn browser_back(
    runtime: State<'_, BrowserRuntime>,
    storage: State<'_, crate::core::storage::StorageRuntime>,
    request: BrowserTabRequest,
) -> Result<BrowserStatus, String> {
    let _storage = storage.access().await;
    runtime.history_action(request, "back").await
}

#[tauri::command]
pub async fn browser_forward(
    runtime: State<'_, BrowserRuntime>,
    storage: State<'_, crate::core::storage::StorageRuntime>,
    request: BrowserTabRequest,
) -> Result<BrowserStatus, String> {
    let _storage = storage.access().await;
    runtime.history_action(request, "forward").await
}

#[tauri::command]
pub async fn browser_reload(
    runtime: State<'_, BrowserRuntime>,
    storage: State<'_, crate::core::storage::StorageRuntime>,
    request: BrowserTabRequest,
) -> Result<BrowserStatus, String> {
    let _storage = storage.access().await;
    runtime.history_action(request, "reload").await
}

#[tauri::command]
pub async fn browser_observe(
    runtime: State<'_, BrowserRuntime>,
    storage: State<'_, crate::core::storage::StorageRuntime>,
    request: BrowserObserveRequest,
) -> Result<BrowserObservation, String> {
    let _storage = storage.access().await;
    runtime.observe(request).await
}

#[tauri::command]
pub async fn browser_act(
    runtime: State<'_, BrowserRuntime>,
    storage: State<'_, crate::core::storage::StorageRuntime>,
    request: BrowserActRequest,
) -> Result<BrowserActResult, String> {
    let _storage = storage.access().await;
    runtime.act(request).await
}
