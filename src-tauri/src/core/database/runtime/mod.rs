// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 数据库运行时状态与事务托管。

mod executor;
mod import;

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

use log::{info, warn};
use sqlx::{Sqlite, SqlitePool};
use tokio::sync::Mutex;

use crate::core::system::paths::{app_directory_path, AppDirectory};

use self::{
    executor::{execute_request, reject_top_level_transaction_sql},
    import::run_import_backup,
};
use super::{
    contract::{
        apply_seed, create_sqlite_pool, ensure_runtime_guards, migrate_database, now_millis,
        resolve_database_contract, DatabaseContractSource,
    },
    protocol::types::{
        DatabaseImportRequest, DatabaseQueryRequest, DatabaseQueryResponse,
        DatabaseTransactionBehavior,
    },
};

const DATABASE_FILE_NAME: &str = "touchai.db";
const TX_IDLE_TIMEOUT: Duration = Duration::from_secs(120);
const TX_CLEANUP_INTERVAL: Duration = Duration::from_secs(30);

type SharedTxEntry = Arc<Mutex<TransactionEntry>>;

/// 已开启事务在 Rust 运行时中的托管记录。
///
/// 这里不暴露业务语义，只保存事务归属窗口、独占连接和空闲过期时间。
struct TransactionEntry {
    window_label: String,
    connection: Option<sqlx::pool::PoolConnection<Sqlite>>,
    expires_at: Instant,
}

#[derive(Clone)]
/// 统一数据库运行时。
///
/// 前端通过 Drizzle 负责业务编排，Rust 只负责：
/// 1. 启动时初始化数据库
/// 2. 提供通用 query / batch / transaction 执行能力
/// 3. 提供导入导出等基础设施能力
pub struct DatabaseRuntime {
    inner: Arc<DatabaseRuntimeInner>,
}

struct DatabaseRuntimeInner {
    pool: SqlitePool,
    database_path: PathBuf,
    database_contract: DatabaseContractSource,
    tx_registry: Mutex<HashMap<String, SharedTxEntry>>,
}

impl DatabaseRuntime {
    /// 启动期初始化数据库运行时。
    ///
    /// Rust 侧不会维护第二套 schema 定义，只执行 `src/database`
    /// 下的迁移与 SQL 工件，确保前端启动前数据库已经可用。
    pub async fn initialize(app: &tauri::App) -> Result<Self, String> {
        let database_path = app_directory_path(AppDirectory::Data)?.join(DATABASE_FILE_NAME);
        let database_contract = resolve_database_contract(app)?;
        let pool = create_sqlite_pool(&database_path).await?;

        // 数据库契约统一收敛在前端目录，release 直接读取 exe 内嵌资源。
        migrate_database(&pool, &database_contract).await?;
        ensure_runtime_guards(&pool, &database_contract).await?;
        apply_seed(&pool, &database_contract).await?;

        let runtime = Self {
            inner: Arc::new(DatabaseRuntimeInner {
                pool,
                database_path,
                database_contract,
                tx_registry: Mutex::new(HashMap::new()),
            }),
        };
        runtime.spawn_tx_cleanup();

        info!(
            "Database runtime initialized at {}",
            runtime.inner.database_path.display()
        );
        Ok(runtime)
    }

    pub async fn query(
        &self,
        request: DatabaseQueryRequest,
    ) -> Result<DatabaseQueryResponse, String> {
        reject_top_level_transaction_sql(&request.sql)?;
        execute_request(&self.inner.pool, request).await
    }

    pub async fn batch(
        &self,
        requests: Vec<DatabaseQueryRequest>,
    ) -> Result<Vec<DatabaseQueryResponse>, String> {
        let mut responses = Vec::with_capacity(requests.len());
        for request in requests {
            responses.push(self.query(request).await?);
        }
        Ok(responses)
    }

    /// 为前端开启一个显式事务，并返回事务句柄。
    ///
    /// 事务生命周期由前端驱动控制，但实际连接由 Rust 托管，
    /// 从而避免通过普通 SQL 字符串模拟事务。
    pub async fn begin_transaction(
        &self,
        window_label: String,
        behavior: Option<DatabaseTransactionBehavior>,
    ) -> Result<String, String> {
        let mut connection = self
            .inner
            .pool
            .acquire()
            .await
            .map_err(|error| format!("Failed to acquire sqlite connection: {error}"))?;

        sqlx::query(
            behavior
                .unwrap_or(DatabaseTransactionBehavior::Deferred)
                .begin_sql(),
        )
        .execute(&mut *connection)
        .await
        .map_err(|error| format!("Failed to begin sqlite transaction: {error}"))?;

        let tx_id = format!("tx_{}_{}", now_millis(), next_counter());
        let entry = Arc::new(Mutex::new(TransactionEntry {
            window_label,
            connection: Some(connection),
            expires_at: Instant::now() + TX_IDLE_TIMEOUT,
        }));

        self.inner
            .tx_registry
            .lock()
            .await
            .insert(tx_id.clone(), entry);
        Ok(tx_id)
    }

    pub async fn tx_query(
        &self,
        tx_id: &str,
        request: DatabaseQueryRequest,
    ) -> Result<DatabaseQueryResponse, String> {
        let entry = {
            let registry = self.inner.tx_registry.lock().await;
            registry
                .get(tx_id)
                .cloned()
                .ok_or_else(|| format!("Transaction '{tx_id}' was not found"))?
        };

        let mut guard = entry.lock().await;
        guard.expires_at = Instant::now() + TX_IDLE_TIMEOUT;
        let connection = guard
            .connection
            .as_mut()
            .ok_or_else(|| format!("Transaction '{tx_id}' is already closed"))?;
        execute_request(&mut **connection, request).await
    }

    pub async fn tx_batch(
        &self,
        tx_id: &str,
        requests: Vec<DatabaseQueryRequest>,
    ) -> Result<Vec<DatabaseQueryResponse>, String> {
        let mut responses = Vec::with_capacity(requests.len());
        for request in requests {
            responses.push(self.tx_query(tx_id, request).await?);
        }
        Ok(responses)
    }

    pub async fn commit_transaction(&self, tx_id: &str) -> Result<(), String> {
        self.finish_transaction(tx_id, "COMMIT").await
    }

    pub async fn rollback_transaction(&self, tx_id: &str) -> Result<(), String> {
        self.finish_transaction(tx_id, "ROLLBACK").await
    }

    /// 在窗口关闭或销毁时回收其遗留事务，避免悬挂写锁。
    pub async fn abort_transactions_for_window(&self, window_label: &str) {
        let tx_ids = {
            let registry = self.inner.tx_registry.lock().await;
            registry
                .iter()
                .filter_map(|(tx_id, entry)| {
                    entry.try_lock().ok().and_then(|guard| {
                        (guard.window_label == window_label).then_some(tx_id.clone())
                    })
                })
                .collect::<Vec<_>>()
        };

        for tx_id in tx_ids {
            if let Err(error) = self.rollback_transaction(&tx_id).await {
                warn!(
                    "Failed to rollback abandoned transaction {}: {}",
                    tx_id, error
                );
            }
        }
    }

    pub async fn export_backup(&self, target_path: &str) -> Result<(), String> {
        sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
            .execute(&self.inner.pool)
            .await
            .map_err(|error| format!("Failed to checkpoint sqlite WAL: {error}"))?;
        std::fs::copy(&self.inner.database_path, target_path)
            .map_err(|error| format!("Failed to export database backup: {error}"))?;
        Ok(())
    }

    /// 导入备份前先确认没有活动事务，避免和前端写入并发冲突。
    pub async fn import_backup(&self, request: DatabaseImportRequest) -> Result<(), String> {
        if !self.inner.tx_registry.lock().await.is_empty() {
            return Err("当前仍有进行中的数据库事务，请稍后重试导入".to_string());
        }

        run_import_backup(
            self.inner.pool.clone(),
            self.inner.database_path.clone(),
            self.inner.database_contract.clone(),
            request,
        )
        .await
    }

    fn spawn_tx_cleanup(&self) {
        let runtime = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(TX_CLEANUP_INTERVAL).await;

                // 定期回收超时事务，避免异常路径一直占用连接和锁。
                let tx_ids = {
                    let registry = runtime.inner.tx_registry.lock().await;
                    registry
                        .iter()
                        .filter_map(|(tx_id, entry)| {
                            entry.try_lock().ok().and_then(|guard| {
                                (guard.expires_at <= Instant::now()).then_some(tx_id.clone())
                            })
                        })
                        .collect::<Vec<_>>()
                };

                for tx_id in tx_ids {
                    if let Err(error) = runtime.rollback_transaction(&tx_id).await {
                        warn!("Failed to cleanup expired transaction {}: {}", tx_id, error);
                    }
                }
            }
        });
    }

    async fn finish_transaction(&self, tx_id: &str, sql: &str) -> Result<(), String> {
        let entry = self
            .inner
            .tx_registry
            .lock()
            .await
            .remove(tx_id)
            .ok_or_else(|| format!("Transaction '{tx_id}' was not found"))?;

        let mut guard = entry.lock().await;
        let mut connection = guard
            .connection
            .take()
            .ok_or_else(|| format!("Transaction '{tx_id}' is already closed"))?;

        sqlx::query(sql)
            .execute(&mut *connection)
            .await
            .map_err(|error| format!("Failed to finalize sqlite transaction '{tx_id}': {error}"))?;
        Ok(())
    }
}

fn next_counter() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(1);
    COUNTER.fetch_add(1, Ordering::Relaxed)
}
