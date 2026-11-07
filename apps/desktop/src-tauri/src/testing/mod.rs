use std::path::Path;

use tauri::{
    test::{mock_builder, MockRuntime},
    App, Builder, Manager, Runtime,
};

use crate::{
    commands,
    core::{
        browser::{
            actions, endpoint,
            types::{BrowserActRequest, BrowserDescriptor, BrowserDomRef},
            url_policy, BrowserRuntime,
        },
        built_in_tools::BuiltInProcessExecutionRegistry,
        database::DatabaseRuntime,
        updater::AppUpdaterState,
        window::{
            search::surface::SearchSurfaceRuntime, search_host::SearchHostRefreshRuntime,
            search_region::SearchRegionRuntime,
            status_reminder::SessionStatusReminderNotificationRuntime, tray::TrayStatusRuntime,
            webview_recovery::WebviewRecoveryRuntime,
        },
    },
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SearchSurfacePolicySnapshot {
    pub hide_on_app_blur: bool,
    pub allow_height_override: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchSurfaceReadinessSnapshot {
    pub renderer_ready: bool,
    pub pending_show_source: Option<String>,
}

pub fn test_builder() -> Builder<MockRuntime> {
    mock_builder()
        .invoke_handler(commands::invoke_handler::<MockRuntime>())
        .manage(SearchSurfaceRuntime::for_tests())
        .manage(SearchHostRefreshRuntime::for_tests())
        .manage(SearchRegionRuntime::for_tests())
        .manage(WebviewRecoveryRuntime::new())
        .manage(SessionStatusReminderNotificationRuntime::for_tests())
        .manage(TrayStatusRuntime::new())
        .manage(BrowserRuntime::new())
        .manage(BuiltInProcessExecutionRegistry::new())
        .manage(AppUpdaterState::default())
        .manage(crate::core::mcp::McpClientManager::new())
}

pub fn attach_test_database_runtime(
    builder: Builder<MockRuntime>,
    database_root: &Path,
) -> Result<Builder<MockRuntime>, String> {
    let runtime =
        tauri::async_runtime::block_on(DatabaseRuntime::initialize_for_tests(database_root))?;
    Ok(builder.manage(runtime))
}

pub fn search_surface_policies<R: Runtime>(app: &App<R>) -> SearchSurfacePolicySnapshot {
    let runtime = app.state::<SearchSurfaceRuntime>();
    SearchSurfacePolicySnapshot {
        hide_on_app_blur: runtime.should_hide_on_app_blur(),
        allow_height_override: runtime.should_allow_height_override(),
    }
}

pub fn search_surface_readiness<R: Runtime>(app: &App<R>) -> SearchSurfaceReadinessSnapshot {
    let runtime = app.state::<SearchSurfaceRuntime>();
    let (renderer_ready, pending_show_source) = runtime.renderer_readiness_snapshot();
    SearchSurfaceReadinessSnapshot {
        renderer_ready,
        pending_show_source: pending_show_source.map(str::to_string),
    }
}

pub fn search_surface_protocol<R: Runtime>(
    app: &App<R>,
) -> crate::core::window::search::surface::SearchSurfaceProtocolSnapshot {
    app.state::<SearchSurfaceRuntime>().protocol_snapshot()
}

pub fn register_search_renderer_load<R: Runtime>(app: &App<R>) -> Result<u64, String> {
    crate::core::window::search::surface::register_renderer_load_on_main_thread(app.handle())
}

pub fn search_region_generation<R: Runtime>(app: &App<R>) -> u64 {
    app.state::<SearchRegionRuntime>().generation()
}

pub fn tray_status_indicator<R: Runtime>(app: &App<R>) -> Option<String> {
    app.state::<TrayStatusRuntime>()
        .status()
        .map(|status| match status {
            crate::core::window::tray::TrayStatusIndicator::Completed => "completed",
            crate::core::window::tray::TrayStatusIndicator::Failed => "failed",
            crate::core::window::tray::TrayStatusIndicator::WaitingApproval => "waiting_approval",
        })
        .map(str::to_string)
}

pub fn session_status_reminder_notifications<R: Runtime>(
    app: &App<R>,
) -> Vec<crate::core::window::status_reminder::SessionStatusReminderNotificationPayload> {
    app.state::<SessionStatusReminderNotificationRuntime>()
        .records()
}

pub fn session_status_reminder_clear_count<R: Runtime>(app: &App<R>) -> usize {
    app.state::<SessionStatusReminderNotificationRuntime>()
        .clear_count()
}

pub fn parse_browser_loopback_endpoint_for_tests(raw: &str) -> Result<serde_json::Value, String> {
    serde_json::to_value(endpoint::parse_loopback_endpoint(raw)?.snapshot())
        .map_err(|error| error.to_string())
}

pub fn validate_browser_navigation_token_for_tests(
    supplied: &str,
    current: &str,
) -> Result<(), String> {
    endpoint::validate_stale_navigation_token(supplied, current)
}

pub fn validate_browser_websocket_endpoint_for_tests(
    websocket_url: &str,
    endpoint_url: &str,
) -> Result<(), String> {
    let endpoint = endpoint::parse_loopback_endpoint(endpoint_url)?;
    endpoint::validate_loopback_websocket(websocket_url, &endpoint)
}

pub fn validate_browser_action_for_tests(
    request: serde_json::Value,
    refs: Vec<serde_json::Value>,
) -> Result<(), String> {
    let request: BrowserActRequest =
        serde_json::from_value(request).map_err(|error| error.to_string())?;
    let refs: Vec<BrowserDomRef> = refs
        .into_iter()
        .map(serde_json::from_value)
        .collect::<Result<_, _>>()
        .map_err(|error| error.to_string())?;
    actions::resolve_ref_action(&request, &refs).map(|_| ())
}

pub fn validate_browser_url_for_tests(raw: &str) -> Result<String, String> {
    url_policy::validate_browser_url(raw)
}

pub type BrowserStartRequestForTests = crate::core::browser::types::BrowserStartRequest;
pub type BrowserDescriptorForTests = BrowserDescriptor;
