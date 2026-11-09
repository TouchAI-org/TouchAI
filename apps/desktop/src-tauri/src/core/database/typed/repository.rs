// Copyright (c) 2026. 千诚. Licensed under GPL v3.

use serde_json::{Map as JsonMap, Value as JsonValue};
use sqlx::{sqlite::SqliteArguments, Sqlite, SqliteConnection, SqlitePool, Transaction};

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
    let query = build_query(sql, params)?;
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
    let query = build_query(sql, params)?;
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

fn build_query<'q>(
    sql: &'q str,
    params: Vec<JsonValue>,
) -> Result<sqlx::query::Query<'q, Sqlite, SqliteArguments>, DatabaseOperationError> {
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql));

    for param in params {
        query = match param {
            JsonValue::Null => query.bind(Option::<String>::None),
            JsonValue::Bool(value) => query.bind(value),
            JsonValue::Number(value) => {
                if let Some(integer) = value.as_i64() {
                    query.bind(integer)
                } else if let Some(float) = value.as_f64() {
                    query.bind(float)
                } else {
                    return Err(DatabaseOperationError::validation(
                        "Unsupported JSON number for sqlite bind",
                    ));
                }
            }
            JsonValue::String(value) => query.bind(value),
            JsonValue::Array(values) => {
                let bytes = values
                    .into_iter()
                    .map(|value| {
                        value
                            .as_u64()
                            .and_then(|number| u8::try_from(number).ok())
                            .ok_or_else(|| {
                                DatabaseOperationError::validation(
                                    "BLOB bind only supports byte arrays",
                                )
                            })
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                query.bind(bytes)
            }
            JsonValue::Object(_) => {
                return Err(DatabaseOperationError::validation(
                    "Object bind is not supported for sqlite runtime",
                ));
            }
        };
    }

    Ok(query)
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use sqlx::{
        sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
        Connection, Row, SqliteConnection,
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

    #[tokio::test]
    async fn user_gets_a_stable_busy_error_when_another_connection_holds_the_write_lock() {
        let root = TempDir::new().expect("temp database directory");
        let path = root.path().join("busy-lock.db");
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .busy_timeout(Duration::from_millis(50));
        let pool = SqlitePoolOptions::new()
            .max_connections(2)
            .connect_with(options.clone())
            .await
            .expect("sqlite pool");
        sqlx::query("CREATE TABLE writes (id INTEGER PRIMARY KEY, value TEXT NOT NULL)")
            .execute(&pool)
            .await
            .expect("create table");

        let mut blocker = SqliteConnection::connect_with(&options)
            .await
            .expect("blocking connection");
        sqlx::query("BEGIN EXCLUSIVE")
            .execute(&mut blocker)
            .await
            .expect("hold write lock");

        let error = begin_immediate(&pool)
            .await
            .expect_err("the lock must reject the writer");
        assert_eq!(error.code, "database-busy");

        sqlx::query("ROLLBACK")
            .execute(&mut blocker)
            .await
            .expect("release write lock");
        blocker.close().await.expect("close blocking connection");
        pool.close().await;
    }
}
