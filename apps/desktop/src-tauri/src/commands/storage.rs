//! Storage commands never accept arbitrary cleanup roots from the renderer.

use std::path::PathBuf;
use tauri::{AppHandle, Manager, Runtime, State, WebviewWindow};

use crate::core::{
    storage::{
        HistoryKind, PublishedAttachment, StorageCategory, StorageCleanupResult,
        StorageCompactionResult, StorageRuntime, StorageSummary,
    },
    system::clipboard::ClipboardRuntime,
};

fn allow_settings<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    if matches!(window.label(), "main" | "settings") {
        Ok(())
    } else {
        Err("storage_invalid_path".into())
    }
}

pub(crate) fn protected_paths<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<PathBuf>, String> {
    app.try_state::<ClipboardRuntime>()
        .map(|clipboard| clipboard.protected_paths())
        .unwrap_or_else(|| Ok(Vec::new()))
}

#[tauri::command]
pub async fn storage_scan<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    storage: State<'_, StorageRuntime>,
) -> Result<StorageSummary, String> {
    allow_settings(&window)?;
    storage.scan(protected_paths(&app)?).await
}

#[tauri::command]
pub async fn storage_cleanup<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    storage: State<'_, StorageRuntime>,
    categories: Vec<StorageCategory>,
) -> Result<StorageCleanupResult, String> {
    allow_settings(&window)?;
    storage
        .cleanup_with_snapshot(categories, move || protected_paths(&app))
        .await
}

#[tauri::command]
pub async fn storage_compact_database<R: Runtime>(
    window: WebviewWindow<R>,
    storage: State<'_, StorageRuntime>,
) -> Result<StorageCompactionResult, String> {
    allow_settings(&window)?;
    storage.compact_database().await
}

#[tauri::command]
pub async fn storage_clear_history<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    storage: State<'_, StorageRuntime>,
    kind: HistoryKind,
) -> Result<(), String> {
    allow_settings(&window)?;
    storage
        .clear_history_with_snapshot(kind, move || protected_paths(&app))
        .await
}

#[tauri::command]
pub async fn storage_hold<R: Runtime>(
    window: WebviewWindow<R>,
    storage: State<'_, StorageRuntime>,
) -> Result<String, String> {
    allow_settings(&window)?;
    storage.hold(window.label()).await
}

#[tauri::command]
pub async fn storage_pin_paths<R: Runtime>(
    window: WebviewWindow<R>,
    storage: State<'_, StorageRuntime>,
    paths: Vec<PathBuf>,
) -> Result<String, String> {
    allow_settings(&window)?;
    storage.pin_paths(window.label(), paths).await
}

#[tauri::command]
pub async fn storage_release<R: Runtime>(
    window: WebviewWindow<R>,
    storage: State<'_, StorageRuntime>,
    activity_id: String,
) -> Result<(), String> {
    allow_settings(&window)?;
    storage.release(window.label(), &activity_id).await
}

#[tauri::command]
pub async fn storage_publish_attachment<R: Runtime>(
    window: WebviewWindow<R>,
    storage: State<'_, StorageRuntime>,
    attachment_type: String,
    source_path: PathBuf,
    expected_hash: Option<String>,
    alias_source_path: Option<PathBuf>,
) -> Result<PublishedAttachment, String> {
    if window.label() != "main" {
        return Err("storage_invalid_path".into());
    }
    storage
        .publish_with_alias(
            attachment_type,
            source_path,
            expected_hash,
            alias_source_path,
        )
        .await
}
