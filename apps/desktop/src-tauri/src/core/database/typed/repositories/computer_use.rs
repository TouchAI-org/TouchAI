// Copyright (c) 2026. 千诚. Licensed under GPL v3.

use serde_json::Value as JsonValue;
use sqlx::SqlitePool;

use super::super::operation::DatabaseOperationError;
use super::super::repository::{begin_immediate, fetch_one, run};

pub(crate) async fn get_setting(
    pool: &SqlitePool,
    key: &str,
) -> Result<Option<String>, DatabaseOperationError> {
    if key.is_empty() {
        return Err(DatabaseOperationError::validation(
            "Computer-use setting key is required",
        ));
    }
    let mut connection = pool.acquire().await.map_err(DatabaseOperationError::from)?;
    let row = fetch_one(
        &mut connection,
        "SELECT value FROM settings WHERE key = ? LIMIT 1",
        vec![JsonValue::String(key.to_string())],
    )
    .await?;
    Ok(row
        .and_then(|row| row.get("value").cloned())
        .and_then(|value| value.as_str().map(str::to_owned)))
}

pub(crate) async fn delete_setting(
    pool: &SqlitePool,
    key: &str,
) -> Result<(), DatabaseOperationError> {
    if key.is_empty() {
        return Err(DatabaseOperationError::validation(
            "Computer-use setting key is required",
        ));
    }
    let mut connection = pool.acquire().await.map_err(DatabaseOperationError::from)?;
    run(
        &mut connection,
        "DELETE FROM settings WHERE key = ?",
        vec![JsonValue::String(key.to_string())],
    )
    .await?;
    Ok(())
}

pub(crate) async fn persist_driver_storage(
    pool: &SqlitePool,
    directory: Option<&str>,
    cleanup: &str,
    directory_key: &str,
    cleanup_key: &str,
) -> Result<(), DatabaseOperationError> {
    if directory_key.is_empty() || cleanup_key.is_empty() {
        return Err(DatabaseOperationError::validation(
            "Computer-use setting keys are required",
        ));
    }
    let mut transaction = begin_immediate(pool).await?;
    match directory {
        Some(directory) => {
            run(
                &mut *transaction,
                "INSERT INTO settings (key, value) VALUES (?, ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                 updated_at = CURRENT_TIMESTAMP",
                vec![
                    JsonValue::String(directory_key.to_string()),
                    JsonValue::String(directory.to_string()),
                ],
            )
            .await?;
        }
        None => {
            run(
                &mut *transaction,
                "DELETE FROM settings WHERE key = ?",
                vec![JsonValue::String(directory_key.to_string())],
            )
            .await?;
        }
    }
    run(
        &mut *transaction,
        "INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value,
         updated_at = CURRENT_TIMESTAMP",
        vec![
            JsonValue::String(cleanup_key.to_string()),
            JsonValue::String(cleanup.to_string()),
        ],
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(DatabaseOperationError::from)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use sqlx::SqlitePool;

    use super::persist_driver_storage;

    #[tokio::test]
    async fn user_gets_an_atomic_driver_storage_update() {
        let pool = SqlitePool::connect("sqlite::memory:")
            .await
            .expect("database");
        sqlx::query(
            "CREATE TABLE settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )",
        )
        .execute(&pool)
        .await
        .expect("settings table");
        sqlx::query(
            "CREATE TRIGGER reject_cleanup BEFORE INSERT ON settings
             WHEN NEW.key = 'cleanup' BEGIN SELECT RAISE(FAIL, 'cleanup rejected'); END",
        )
        .execute(&pool)
        .await
        .expect("reject trigger");

        let error = persist_driver_storage(
            &pool,
            Some("/tmp/drivers"),
            &json!([]).to_string(),
            "directory",
            "cleanup",
        )
        .await
        .expect_err("the cleanup write must fail");

        assert_eq!(error.code, "database-query");
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM settings WHERE key = 'directory'")
                .fetch_one(&pool)
                .await
                .expect("count");
        assert_eq!(count, 0, "the directory write must roll back");
    }
}
