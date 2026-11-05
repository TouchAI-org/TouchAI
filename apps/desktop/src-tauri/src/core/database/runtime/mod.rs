// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 数据库运行时状态与基础设施。

mod export;
mod import;

use std::{path::PathBuf, sync::Arc};

use log::info;
use sqlx::SqlitePool;

use crate::core::system::paths::{app_directory_path, AppDirectory};

use self::{export::run_export_backup, import::run_import_backup};
use super::{
    contract::{
        apply_seed, create_sqlite_pool, ensure_runtime_guards, migrate_database,
        resolve_database_contract, DatabaseContractSource,
    },
    protocol::types::DatabaseImportRequest,
};

const DATABASE_FILE_NAME: &str = "touchai.db";

#[derive(Clone)]
/// 统一数据库运行时。
///
/// Rust owns schema migration, typed repositories, business transactions,
/// backup/import, and the only production SQLite write path.
pub struct DatabaseRuntime {
    inner: Arc<DatabaseRuntimeInner>,
}

struct DatabaseRuntimeInner {
    pool: SqlitePool,
    database_path: PathBuf,
    database_contract: DatabaseContractSource,
}

impl DatabaseRuntime {
    /// 启动期初始化数据库运行时。
    ///
    /// Rust 侧不会维护第二套 schema 定义，只执行 `src/database`
    /// 下的迁移与 SQL 工件，确保前端启动前数据库已经可用。
    pub async fn initialize(app: &tauri::App) -> Result<Self, String> {
        let database_path = app_directory_path(AppDirectory::Data)?.join(DATABASE_FILE_NAME);
        let database_contract = resolve_database_contract(app)?;
        Self::initialize_with_paths(database_path, database_contract).await
    }

    #[doc(hidden)]
    pub async fn initialize_for_tests(root: &std::path::Path) -> Result<Self, String> {
        let database_path = root.join(DATABASE_FILE_NAME);
        let database_contract = DatabaseContractSource::from_root(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .ok_or_else(|| "Failed to resolve project database contract directory".to_string())?
                .join("src")
                .join("database"),
        )?;
        Self::initialize_with_paths(database_path, database_contract).await
    }

    /// Execute one named, typed database operation owned by this runtime.
    pub(crate) async fn execute_operation(
        &self,
        window_label: &str,
        operation: crate::core::database::typed::DatabaseOperation,
    ) -> Result<serde_json::Value, crate::core::database::typed::DatabaseOperationError> {
        crate::core::database::typed::execute(&self.inner.pool, window_label, operation).await
    }

    pub async fn export_backup(&self, window_label: &str, target_path: &str) -> Result<(), String> {
        if !crate::core::database::typed::backup_allows(window_label) {
            return Err(format!(
                "Database operation is not allowed for window '{}'",
                window_label
            ));
        }

        run_export_backup(&self.inner.pool, &self.inner.database_path, target_path).await
    }

    pub async fn import_backup(
        &self,
        window_label: &str,
        request: DatabaseImportRequest,
    ) -> Result<(), String> {
        if !crate::core::database::typed::backup_allows(window_label) {
            return Err(format!(
                "Database operation is not allowed for window '{}'",
                window_label
            ));
        }

        run_import_backup(
            self.inner.pool.clone(),
            self.inner.database_path.clone(),
            self.inner.database_contract.clone(),
            request,
        )
        .await
    }

    /// Returns the database path to test-only harness code.
    #[doc(hidden)]
    pub fn database_path_for_tests(&self) -> &std::path::Path {
        &self.inner.database_path
    }

    async fn initialize_with_paths(
        database_path: PathBuf,
        database_contract: DatabaseContractSource,
    ) -> Result<Self, String> {
        let pool = create_sqlite_pool(&database_path).await?;

        // 数据库契约统一收敛在前端目录，release 直接读取 exe 内嵌资源。
        {
            let mut connection = pool
                .acquire()
                .await
                .map_err(|error| format!("Failed to acquire migration connection: {error}"))?;
            migrate_database(&mut connection, &database_contract).await?;
        }
        ensure_runtime_guards(&pool, &database_contract).await?;
        apply_seed(&pool, &database_contract).await?;

        let runtime = Self {
            inner: Arc::new(DatabaseRuntimeInner {
                pool,
                database_path,
                database_contract,
            }),
        };
        info!(
            "Database runtime initialized at {}",
            runtime.inner.database_path.display()
        );
        Ok(runtime)
    }
}
