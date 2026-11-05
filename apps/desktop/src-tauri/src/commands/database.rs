// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 数据库运行时命令。

use tauri::{Runtime, State, WebviewWindow};

use crate::core::database::{
    typed::{DatabaseOperation, DatabaseOperationError},
    types::{
        DatabaseBackupExportRequest, DatabaseImportRequest, DatabaseQueryRequest,
        DatabaseQueryResponse, DatabaseTransactionBehavior,
    },
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
