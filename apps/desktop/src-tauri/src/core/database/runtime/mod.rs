// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 数据库运行时状态与基础设施。

mod analytics_snapshot;
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

    /// The single shared SQLite pool over `touchai.db`.
    ///
    /// Crate-internal typed subsystems (analytics) run their own statements on
    /// this pool instead of opening a second connection or database.
    pub(crate) fn pool(&self) -> &SqlitePool {
        &self.inner.pool
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::analytics::ANALYTICS_STATE_SETTING;

    #[tokio::test]
    async fn user_gets_an_exported_backup_without_analytics_identity_or_payloads() {
        let root = tempfile::tempdir().expect("temp dir");
        let runtime = DatabaseRuntime::initialize_for_tests(root.path())
            .await
            .expect("database runtime");
        let pool = runtime.pool();

        let state = serde_json::json!({
            "policyVersion": 1,
            "status": "disabled",
            "consentExplicit": 1,
            "installationId": "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
            "consentEpoch": 4,
            "observationStartedDay": "2026-01-01",
            "firstSuccessDay": null,
            "lastObservedAppVersion": "1.2.2",
            "pendingUpdateJson": null,
            "deploymentKey": "https://analytics.invalid/send|project",
            "updatedAtMs": 1
        });
        sqlx::query("INSERT INTO settings (key, value) VALUES (?, ?)")
            .bind(ANALYTICS_STATE_SETTING)
            .bind(state.to_string())
            .execute(pool)
            .await
            .expect("seed state");
        sqlx::query("INSERT INTO settings (key, value) VALUES ('keep', '1')")
            .execute(pool)
            .await
            .expect("seed settings");

        let target = root.path().join("exported.db");
        runtime
            .export_backup("main", target.to_string_lossy().as_ref())
            .await
            .expect("export");

        let exported = create_sqlite_pool(&target).await.expect("open export");
        let value: String = sqlx::query_scalar("SELECT value FROM settings WHERE key = ?")
            .bind(ANALYTICS_STATE_SETTING)
            .fetch_one(&exported)
            .await
            .expect("exported state");
        let state: serde_json::Value = serde_json::from_str(&value).expect("state json");
        assert_eq!(state["status"], "disabled");
        assert_eq!(state["consentExplicit"], 1);
        assert_eq!(state["installationId"], serde_json::Value::Null);
        assert_eq!(state["consentEpoch"], 0);
        assert_eq!(state["deploymentKey"], "");
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = 'keep'")
                .fetch_one(&exported)
                .await
                .unwrap(),
            "1"
        );
        assert!(sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(&exported)
            .await
            .unwrap()
            .is_empty());
    }
}
