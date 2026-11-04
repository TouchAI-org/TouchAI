// Copyright (c) 2026. 千诚. Licensed under GPL v3.

use serde_json::{Map as JsonMap, Value as JsonValue};
use sqlx::{Sqlite, SqliteConnection, SqlitePool, Transaction};

use super::operation::DatabaseOperationError;

/// 开始一个写事务。
///
/// Typed repositories 的写事务几乎都是先读后写。SQLite WAL 下 deferred
/// 事务会先取得读快照，之后升级写锁时可能直接返回 SQLITE_BUSY，且
/// busy_timeout 对此无效。统一使用 BEGIN IMMEDIATE，让并发写在事务入口
/// 排队，避免把可重试的锁竞争暴露成业务失败。
pub(crate) async fn begin_immediate(
    pool: &SqlitePool,
) -> Result<Transaction<'static, Sqlite>, DatabaseOperationError> {
    pool.begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(DatabaseOperationError::from)
}

pub(crate) async fn fetch_rows(
    connection: &mut SqliteConnection,
    sql: &str,
    params: Vec<JsonValue>,
) -> Result<Vec<JsonMap<String, JsonValue>>, DatabaseOperationError> {
    let query = crate::core::database::runtime::build_query(sql, params)?;
    let rows = query
        .fetch_all(&mut *connection)
        .await
        .map_err(DatabaseOperationError::from)?;
    rows.iter()
        .map(crate::core::database::protocol::decode::decode_row)
        .collect::<Result<Vec<_>, _>>()
        .map_err(DatabaseOperationError::unavailable)
}

pub(crate) async fn fetch_one(
    connection: &mut SqliteConnection,
    sql: &str,
    params: Vec<JsonValue>,
) -> Result<Option<JsonMap<String, JsonValue>>, DatabaseOperationError> {
    Ok(fetch_rows(connection, sql, params)
        .await?
        .into_iter()
        .next())
}

pub(crate) async fn run(
    connection: &mut SqliteConnection,
    sql: &str,
    params: Vec<JsonValue>,
) -> Result<u64, DatabaseOperationError> {
    let query = crate::core::database::runtime::build_query(sql, params)?;
    let result = query
        .execute(&mut *connection)
        .await
        .map_err(DatabaseOperationError::from)?;
    Ok(result.rows_affected())
}

pub(crate) fn json_object(rows: Vec<JsonMap<String, JsonValue>>) -> JsonValue {
    JsonValue::Array(rows.into_iter().map(JsonValue::Object).collect())
}

pub(crate) fn json_row(row: Option<JsonMap<String, JsonValue>>) -> JsonValue {
    row.map(JsonValue::Object).unwrap_or(JsonValue::Null)
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use sqlx::{
        sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
        Row,
    };
    use tempfile::TempDir;

    use super::begin_immediate;

    #[tokio::test]
    async fn user_waiting_to_write_waits_for_the_current_writer() {
        let root = TempDir::new().expect("temp database directory");
        let options = SqliteConnectOptions::new()
            .filename(root.path().join("write-lock.db"))
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .busy_timeout(Duration::from_secs(5));
        let pool = SqlitePoolOptions::new()
            .max_connections(2)
            .connect_with(options)
            .await
            .expect("sqlite pool");
        sqlx::query("CREATE TABLE writes (id INTEGER PRIMARY KEY, value TEXT NOT NULL)")
            .execute(&pool)
            .await
            .expect("create table");

        let mut first = begin_immediate(&pool).await.expect("first writer");
        sqlx::query("INSERT INTO writes (value) VALUES ('first')")
            .execute(&mut *first)
            .await
            .expect("first write");

        let waiting_pool = pool.clone();
        let waiting_writer = tokio::spawn(async move {
            let mut second = begin_immediate(&waiting_pool).await.expect("second writer");
            let count: i64 = sqlx::query("SELECT count(*) AS count FROM writes")
                .fetch_one(&mut *second)
                .await
                .expect("read after waiting")
                .get("count");
            assert_eq!(count, 1);
            sqlx::query("INSERT INTO writes (value) VALUES ('second')")
                .execute(&mut *second)
                .await
                .expect("second write");
            second.commit().await.expect("second commit");
        });

        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            !waiting_writer.is_finished(),
            "the second writer must wait instead of using a stale read snapshot"
        );

        first.commit().await.expect("first commit");
        tokio::time::timeout(Duration::from_secs(2), waiting_writer)
            .await
            .expect("second writer timed out")
            .expect("second writer task");

        let count: i64 = sqlx::query("SELECT count(*) AS count FROM writes")
            .fetch_one(&pool)
            .await
            .expect("final count")
            .get("count");
        assert_eq!(count, 2);
    }
}
