use std::path::{Path, PathBuf};

use tauri::{
    test::{mock_builder, MockRuntime},
    App, Builder, Manager, Runtime,
};

use crate::{
    commands,
    core::{
        app_use::AppUseRuntime,
        database::DatabaseRuntime,
        updater::AppUpdaterState,
        window::{
            popup::PopupRegistry, search::surface::SearchSurfaceRuntime,
            status_reminder::SessionStatusReminderNotificationRuntime, tray::TrayStatusRuntime,
        },
    },
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SearchSurfacePolicySnapshot {
    pub hide_on_app_blur: bool,
    pub allow_height_override: bool,
}

pub fn test_builder() -> Builder<MockRuntime> {
    mock_builder()
        .invoke_handler(commands::invoke_handler::<MockRuntime>())
        .manage(PopupRegistry::new())
        .manage(SearchSurfaceRuntime::new())
        .manage(SessionStatusReminderNotificationRuntime::for_tests())
        .manage(TrayStatusRuntime::new())
        .manage(AppUseRuntime::new())
        .manage(AppUpdaterState::default())
}

pub fn configure_app_use_wps_owned_root_for_tests(root: &Path) -> Result<(), String> {
    std::env::set_var("TOUCHAI_APP_USE_WPS_OWNED_ROOT", root);
    std::env::set_var("TOUCHAI_APP_USE_OWNED_SECRET", "app-use-owned-test-secret");
    std::fs::create_dir_all(root)
        .map_err(|error| format!("Failed to create WPS App Use owned root: {error}"))
}

pub fn configure_app_use_office_owned_root_for_tests(root: &Path) -> Result<(), String> {
    std::env::set_var("TOUCHAI_APP_USE_OFFICE_OWNED_ROOT", root);
    std::env::set_var("TOUCHAI_APP_USE_OWNED_SECRET", "app-use-owned-test-secret");
    std::fs::create_dir_all(root)
        .map_err(|error| format!("Failed to create Office App Use owned root: {error}"))
}

pub fn mark_app_use_wps_owned_target_for_tests(
    path: &Path,
    app_label: &str,
) -> Result<PathBuf, String> {
    crate::core::app_use::wps::mark_owned_wps_target(
        path,
        app_label,
        "TouchAI App Use integration test",
    )
}

pub fn mark_app_use_office_owned_target_for_tests(
    path: &Path,
    app_label: &str,
) -> Result<PathBuf, String> {
    crate::core::app_use::office::mark_owned_office_target(
        path,
        app_label,
        "TouchAI App Use integration test",
    )
}

pub fn attach_test_database_runtime(
    builder: Builder<MockRuntime>,
    database_root: &Path,
) -> Result<Builder<MockRuntime>, String> {
    let runtime =
        tauri::async_runtime::block_on(DatabaseRuntime::initialize_for_tests(database_root))?;
    Ok(builder.manage(runtime))
}

pub fn popup_registry_has<R: Runtime>(app: &App<R>, id: &str) -> bool {
    app.state::<PopupRegistry>().has(id)
}

pub fn search_surface_policies<R: Runtime>(app: &App<R>) -> SearchSurfacePolicySnapshot {
    let runtime = app.state::<SearchSurfaceRuntime>();
    SearchSurfacePolicySnapshot {
        hide_on_app_blur: runtime.should_hide_on_app_blur(),
        allow_height_override: runtime.should_allow_height_override(),
    }
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
