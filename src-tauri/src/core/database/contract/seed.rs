// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 数据库初始种子执行器。

use sqlx::{Pool, Sqlite};

use super::DatabaseContractSource;

/// 执行数据库种子工件。
///
/// 种子内容统一维护在 `src/database/artifacts/runtime/seed.sql`，
/// Rust 只负责读取并执行，避免再维护一份内嵌初始化 SQL。
pub async fn apply_seed(
    pool: &Pool<Sqlite>,
    database_contract: &DatabaseContractSource,
) -> Result<(), String> {
    let seed_sql = database_contract.read_text(&["artifacts", "runtime", "seed.sql"])?;

    sqlx::raw_sql(&seed_sql)
        .execute(pool)
        .await
        .map_err(|error| format!("Failed to execute database seed artifact: {error}"))?;

    Ok(())
}
