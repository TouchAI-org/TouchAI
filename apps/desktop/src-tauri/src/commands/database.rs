// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 数据库运行时命令。

use tauri::{Runtime, State, WebviewWindow};

use crate::core::database::{
    typed::{DatabaseOperation, DatabaseOperationError},
    types::{DatabaseBackupExportRequest, DatabaseImportRequest},
    DatabaseRuntime,
};

/// Execute one typed database operation after applying the window surface guard.
#[tauri::command]
pub async fn database_operation<R: Runtime>(
    window: WebviewWindow<R>,
    runtime: State<'_, DatabaseRuntime>,
    request: DatabaseOperation,
) -> Result<serde_json::Value, DatabaseOperationError> {
    runtime.execute_operation(window.label(), request).await
}

/// 导出数据库备份。
#[tauri::command]
pub async fn database_export_backup<R: Runtime>(
    window: WebviewWindow<R>,
    runtime: State<'_, DatabaseRuntime>,
    request: DatabaseBackupExportRequest,
) -> Result<(), String> {
    runtime
        .export_backup(window.label(), &request.target_path)
        .await
}

/// 导入数据库备份。
#[tauri::command]
pub async fn database_import_backup<R: Runtime>(
    window: WebviewWindow<R>,
    runtime: State<'_, DatabaseRuntime>,
    request: DatabaseImportRequest,
) -> Result<(), String> {
    runtime.import_backup(window.label(), request).await
}
