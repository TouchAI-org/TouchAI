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
    request: BrowserStartRequest,
) -> Result<BrowserStatus, String> {
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
    request: BrowserConnectExistingRequest,
) -> Result<BrowserConnectExistingResult, String> {
    runtime.connect_existing(request).await
}

#[tauri::command]
pub fn browser_stop(runtime: State<'_, BrowserRuntime>) -> BrowserStatus {
    runtime.stop()
}

#[tauri::command]
pub async fn browser_navigate(
    runtime: State<'_, BrowserRuntime>,
    request: BrowserNavigateRequest,
) -> Result<BrowserStatus, String> {
    runtime.navigate(request).await
}

#[tauri::command]
pub async fn browser_back(
    runtime: State<'_, BrowserRuntime>,
    request: BrowserTabRequest,
) -> Result<BrowserStatus, String> {
    runtime.history_action(request, "back").await
}

#[tauri::command]
pub async fn browser_forward(
    runtime: State<'_, BrowserRuntime>,
    request: BrowserTabRequest,
) -> Result<BrowserStatus, String> {
    runtime.history_action(request, "forward").await
}

#[tauri::command]
pub async fn browser_reload(
    runtime: State<'_, BrowserRuntime>,
    request: BrowserTabRequest,
) -> Result<BrowserStatus, String> {
    runtime.history_action(request, "reload").await
}

#[tauri::command]
pub async fn browser_observe(
    runtime: State<'_, BrowserRuntime>,
    request: BrowserObserveRequest,
) -> Result<BrowserObservation, String> {
    runtime.observe(request).await
}

#[tauri::command]
pub async fn browser_act(
    runtime: State<'_, BrowserRuntime>,
    request: BrowserActRequest,
) -> Result<BrowserActResult, String> {
    runtime.act(request).await
}
