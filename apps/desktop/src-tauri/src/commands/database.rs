// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 数据库运行时命令。

use tauri::{AppHandle, Manager, Runtime, State, WebviewWindow};

use crate::core::analytics::AnalyticsRuntime;
use crate::core::database::{
    types::{
        DatabaseImportMode, DatabaseImportRequest, DatabaseQueryRequest, DatabaseQueryResponse,
        DatabaseTransactionBehavior,
    },
    DatabaseRuntime,
};

/// 通用数据库查询入口。
#[tauri::command]
pub async fn database_query(
    runtime: State<'_, DatabaseRuntime>,
    request: DatabaseQueryRequest,
) -> Result<DatabaseQueryResponse, String> {
    runtime.query(request).await
}

/// 顺序执行一组独立查询。
#[tauri::command]
pub async fn database_batch(
    runtime: State<'_, DatabaseRuntime>,
    requests: Vec<DatabaseQueryRequest>,
) -> Result<Vec<DatabaseQueryResponse>, String> {
    runtime.batch(requests).await
}

/// 开启由 Rust 托管连接生命周期的事务。
#[tauri::command]
pub async fn database_tx_begin<R: Runtime>(
    window: WebviewWindow<R>,
    runtime: State<'_, DatabaseRuntime>,
    behavior: Option<DatabaseTransactionBehavior>,
) -> Result<String, String> {
    runtime
        .begin_transaction(window.label().to_string(), behavior)
        .await
}

/// 在指定事务内执行单条查询。
#[tauri::command]
pub async fn database_tx_query(
    runtime: State<'_, DatabaseRuntime>,
    tx_id: String,
    request: DatabaseQueryRequest,
) -> Result<DatabaseQueryResponse, String> {
    runtime.tx_query(&tx_id, request).await
}

/// 在指定事务内顺序执行一组查询。
#[tauri::command]
pub async fn database_tx_batch(
    runtime: State<'_, DatabaseRuntime>,
    tx_id: String,
    requests: Vec<DatabaseQueryRequest>,
) -> Result<Vec<DatabaseQueryResponse>, String> {
    runtime.tx_batch(&tx_id, requests).await
}

/// 提交事务。
#[tauri::command]
pub async fn database_tx_commit(
    runtime: State<'_, DatabaseRuntime>,
    tx_id: String,
) -> Result<(), String> {
    runtime.commit_transaction(&tx_id).await
}

/// 回滚事务。
#[tauri::command]
pub async fn database_tx_rollback(
    runtime: State<'_, DatabaseRuntime>,
    tx_id: String,
) -> Result<(), String> {
    runtime.rollback_transaction(&tx_id).await
}

/// 导出数据库备份。
#[tauri::command]
pub async fn database_export_backup<R: Runtime>(
    app: AppHandle<R>,
    runtime: State<'_, DatabaseRuntime>,
    target_path: String,
    mode: Option<DatabaseImportMode>,
) -> Result<(), String> {
    let mode = mode.unwrap_or_default();
    let storage = app
        .try_state::<crate::core::storage::StorageRuntime>()
        .map(|state| state.inner().clone());
    let runtime = runtime.inner().clone();
    tokio::spawn(async move {
        let _storage_guard = match &storage {
            Some(storage) => Some(storage.exclusive().await?),
            None => None,
        };
        let target = std::path::Path::new(&target_path);
        match target.extension().and_then(|extension| extension.to_str()) {
            Some(extension) if extension.eq_ignore_ascii_case("zip") => {
                let storage = storage.ok_or("storage_io_failed")?;
                runtime
                    .export_scoped_backup(target, storage.cache_root(), mode)
                    .await
            }
            Some(extension) if extension.eq_ignore_ascii_case("db") => {
                if mode != DatabaseImportMode::Full {
                    return Err("database_backup_scope_requires_zip".into());
                }
                if let Some(storage) = &storage {
                    let cache = storage.cache_root().to_path_buf();
                    let destination = target.to_path_buf();
                    let inside = tokio::task::spawn_blocking(move || {
                        let cache = crate::core::storage::files::resolve_platform_path(&cache)?;
                        let destination =
                            crate::core::storage::files::resolve_platform_path(&destination)?;
                        Ok::<_, String>(destination.starts_with(cache))
                    })
                    .await
                    .map_err(|_| "storage_io_failed")??;
                    if inside {
                        return Err("storage_invalid_path".into());
                    }
                }
                runtime.export_backup(&target_path).await
            }
            _ => Err("storage_invalid_path".into()),
        }
    })
    .await
    .map_err(|_| "storage_io_failed".to_string())?
}

#[tauri::command]
pub async fn database_backup_scope(source_path: String) -> Result<DatabaseImportMode, String> {
    DatabaseRuntime::backup_scope(source_path.into()).await
}

/// 导入数据库备份。
///
/// 这里保持同步命令签名，是为了与当前前端调用约定保持简单一致；
/// 实际导入流程仍在异步运行时中执行。
#[tauri::command]
pub fn database_import_backup<R: Runtime>(
    app: AppHandle<R>,
    runtime: State<'_, DatabaseRuntime>,
    request: DatabaseImportRequest,
) -> Result<(), String> {
    tauri::async_runtime::block_on(async {
        let storage = app
            .try_state::<crate::core::storage::StorageRuntime>()
            .map(|state| state.inner().clone());
        let _storage_guard = match &storage {
            Some(storage) => Some(storage.exclusive().await?),
            None => None,
        };
        let extension = std::path::Path::new(&request.source_path)
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let result = if extension == "zip" {
            let storage = storage.ok_or("storage_io_failed")?;
            runtime
                .import_full_backup(request, storage.cache_root())
                .await
        } else if extension == "db" {
            runtime.import_backup(request).await.map_err(|error| {
                if error.starts_with("Failed to detach import database:") {
                    format!("database_import_committed:{error}")
                } else {
                    error
                }
            })
        } else {
            return Err("storage_invalid_path".into());
        };
        let synchronize = if let Some(analytics) = app.try_state::<AnalyticsRuntime>() {
            analytics.synchronize_after_restore().await
        } else {
            Ok(())
        };
        match (result, synchronize) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(error), Ok(())) => Err(error),
            (Ok(()), Err(error)) => Err(format!("database_import_committed:{error}")),
            (Err(error), Err(synchronize)) => Err(format!(
                "{error}; analytics reconciliation failed: {synchronize}"
            )),
        }
    })
}
