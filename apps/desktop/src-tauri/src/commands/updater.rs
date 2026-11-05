// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 应用更新命令。

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::{Map as JsonMap, Value as JsonValue};
use tauri::{AppHandle, Manager, Runtime, State};

use crate::core::analytics::{
    events, AnalyticsOperationHandle, AnalyticsRuntime, AnalyticsTrackRequest,
};
use crate::core::updater::notification::AppUpdateNotificationPayload;
use crate::core::updater::{
    self, AppUpdateChannel, AppUpdateCheckResult, AppUpdateInfo, AppUpdaterState,
};

use crate::core::{built_in_tools::BuiltInProcessExecutionRegistry, mcp::McpClientManager};

const ANALYTICS_CAPTURE_TIMEOUT: Duration = Duration::from_millis(50);

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateInstallAnalytics {
    update_operation_id: String,
    source: String,
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

fn install_handoff_request(
    analytics: &AppUpdateInstallAnalytics,
    operation_id: &str,
    result: &str,
    from_version: Option<&str>,
    to_version: &str,
) -> AnalyticsTrackRequest {
    let mut attributes = JsonMap::new();
    attributes.insert(
        "update_operation_id".to_string(),
        JsonValue::String(analytics.update_operation_id.clone()),
    );
    attributes.insert(
        "phase".to_string(),
        JsonValue::String("install_handoff".to_string()),
    );
    attributes.insert("result".to_string(), JsonValue::String(result.to_string()));
    attributes.insert(
        "source".to_string(),
        JsonValue::String(analytics.source.clone()),
    );
    if let Some(from_version) = from_version.filter(|value| events::is_version_shaped(value)) {
        attributes.insert(
            "from_version".to_string(),
            JsonValue::String(from_version.to_string()),
        );
    }
    if events::is_version_shaped(to_version) {
        attributes.insert(
            "to_version".to_string(),
            JsonValue::String(to_version.to_string()),
        );
    }
    AnalyticsTrackRequest {
        event_name: "app.update_transition".to_string(),
        occurred_at_ms: now_millis(),
        operation_id: Some(operation_id.to_string()),
        attributes,
    }
}

async fn capture_install_analytics<R: Runtime>(
    app: &AppHandle<R>,
) -> Option<(AnalyticsRuntime, AnalyticsOperationHandle)> {
    let runtime = app
        .try_state::<AnalyticsRuntime>()
        .map(|runtime| runtime.inner().clone())?;
    let operation = runtime
        .begin_operation_with_timeout(ANALYTICS_CAPTURE_TIMEOUT)
        .await?;
    Some((runtime, operation))
}

#[tauri::command]
pub async fn updater_check_for_updates(
    state: State<'_, AppUpdaterState>,
    channel: AppUpdateChannel,
) -> Result<AppUpdateCheckResult, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || updater::check_for_updates(&state, channel))
        .await
        .map_err(|error| format!("check for updates task join failed: {}", error))?
}

#[tauri::command]
pub async fn updater_show_update_notification<R: Runtime>(
    app: AppHandle<R>,
    payload: AppUpdateNotificationPayload,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || updater::notification::show(&app, &payload))
        .await
        .map_err(|error| format!("Update notification task failed: {error}"))?
}

#[tauri::command]
pub async fn updater_open_update_settings<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    crate::core::window::settings::build_update_settings_window(&app).await
}

#[tauri::command]
pub async fn updater_download_update<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppUpdaterState>,
    channel: AppUpdateChannel,
    version: String,
    file_name: String,
) -> Result<AppUpdateInfo, String> {
    updater::download_update(app, state.inner(), channel, &version, &file_name).await
}

#[tauri::command]
pub async fn updater_install_update<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppUpdaterState>,
    channel: AppUpdateChannel,
    version: String,
    file_name: String,
    analytics: AppUpdateInstallAnalytics,
) -> Result<bool, String> {
    let from_version = app.package_info().version.to_string();
    let install_analytics = capture_install_analytics(&app).await;
    let result = async {
        state.validate_install(channel, &version, &file_name)?;
        if let Some(client_manager) = app.try_state::<McpClientManager>() {
            client_manager.disconnect_all().await?;
        }

        if let Some(registry) = app.try_state::<BuiltInProcessExecutionRegistry>() {
            let cancelled = registry.cancel_all();
            if cancelled > 0 {
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
        }

        updater::install_update(state.inner(), channel, &version, &file_name).await
    }
    .await;
    if let Some((runtime, operation)) = install_analytics.as_ref() {
        let request = install_handoff_request(
            &analytics,
            &operation.operation_id,
            update_result_label(&result),
            Some(&from_version),
            &version,
        );
        let _ = runtime
            .track_install_handoff(request, Some(from_version.clone()), version.clone())
            .await;
        runtime.complete_operation(&operation.operation_id).await;
    }

    if result.is_ok() {
        app.exit(0);
    }
    result
}

fn update_result_label(result: &Result<bool, String>) -> &'static str {
    if result.is_ok() {
        "success"
    } else {
        "failure"
    }
}

#[cfg(test)]
mod tests {
    use super::{install_handoff_request, AppUpdateInstallAnalytics};

    #[test]
    fn user_gets_the_install_handoff_recorded_with_the_original_update_operation() {
        let analytics = AppUpdateInstallAnalytics {
            update_operation_id: "11111111-1111-4111-8111-111111111111".to_string(),
            source: "user".to_string(),
        };

        let request =
            install_handoff_request(&analytics, "operation-1", "success", Some("1.0.0"), "2.0.0");

        assert_eq!(request.event_name, "app.update_transition");
        assert_eq!(request.operation_id.as_deref(), Some("operation-1"));
        assert_eq!(request.attributes["phase"], "install_handoff");
        assert_eq!(request.attributes["result"], "success");
        assert_eq!(request.attributes["source"], "user");
        assert_eq!(request.attributes["from_version"], "1.0.0");
        assert_eq!(request.attributes["to_version"], "2.0.0");
        assert_eq!(
            request.attributes["update_operation_id"],
            "11111111-1111-4111-8111-111111111111"
        );
    }

    #[test]
    fn user_gets_versions_outside_the_registry_shape_omitted_from_native_handoff() {
        for length in [65, 200] {
            let long_version = format!("1.2.3+{}", "a".repeat(length - 6));
            assert_eq!(long_version.len(), length);
            let analytics = AppUpdateInstallAnalytics {
                update_operation_id: "11111111-1111-4111-8111-111111111111".to_string(),
                source: "user".to_string(),
            };

            let request = install_handoff_request(
                &analytics,
                "operation-1",
                "success",
                Some("https://updates.touch-ai.org/1.0.0"),
                &long_version,
            );

            assert!(!request.attributes.contains_key("from_version"));
            assert!(!request.attributes.contains_key("to_version"));
            assert_eq!(request.attributes["phase"], "install_handoff");
            assert_eq!(request.attributes["result"], "success");
        }
    }
}
