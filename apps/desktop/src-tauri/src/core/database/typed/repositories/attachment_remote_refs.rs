// Copyright (c) 2026. 千诚. Licensed under GPL v3.

use serde_json::Value as JsonValue;
use sqlx::SqlitePool;

use super::super::operation::{AttachmentRemoteRefInput, DatabaseOperationError};
use super::super::repository::{begin_immediate, fetch_one, run};

const ISO_FORMAT: &[time::format_description::FormatItem<'static>] = time::macros::format_description!(
    "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z"
);

fn now_iso() -> Result<String, DatabaseOperationError> {
    time::OffsetDateTime::now_utc()
        .format(ISO_FORMAT)
        .map_err(|error| DatabaseOperationError::unavailable(error.to_string()))
}

pub(super) async fn find(
    pool: &SqlitePool,
    attachment_id: i64,
    provider_id: i64,
    transport_kind: String,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = pool.acquire().await.map_err(DatabaseOperationError::from)?;
    let row = fetch_one(
        &mut connection,
        "SELECT * FROM attachment_remote_refs
         WHERE attachment_id = ? AND provider_id = ? AND transport_kind = ?
         LIMIT 1",
        vec![
            JsonValue::Number(attachment_id.into()),
            JsonValue::Number(provider_id.into()),
            JsonValue::String(transport_kind),
        ],
    )
    .await?;
    Ok(row.map(JsonValue::Object).unwrap_or(JsonValue::Null))
}

pub(super) async fn upsert(
    pool: &SqlitePool,
    data: AttachmentRemoteRefInput,
) -> Result<JsonValue, DatabaseOperationError> {
    let now = now_iso()?;
    let updated_at = data.updated_at.unwrap_or_else(|| now.clone());
    let created_at = data.created_at.unwrap_or_else(|| updated_at.clone());
    let last_used_at = data.last_used_at.unwrap_or_else(|| updated_at.clone());
    let mut transaction = begin_immediate(pool).await?;
    let row = fetch_one(
        &mut *transaction,
        "INSERT INTO attachment_remote_refs (
             attachment_id, provider_id, transport_kind, remote_ref, mime_type,
             expires_at, last_used_at, created_at, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(attachment_id, provider_id, transport_kind) DO UPDATE SET
             remote_ref = excluded.remote_ref,
             mime_type = excluded.mime_type,
             expires_at = excluded.expires_at,
             last_used_at = excluded.last_used_at,
             updated_at = excluded.updated_at
         RETURNING *",
        vec![
            JsonValue::Number(data.attachment_id.into()),
            JsonValue::Number(data.provider_id.into()),
            JsonValue::String(data.transport_kind),
            JsonValue::String(data.remote_ref),
            data.mime_type
                .map(JsonValue::String)
                .unwrap_or(JsonValue::Null),
            data.expires_at
                .map(JsonValue::String)
                .unwrap_or(JsonValue::Null),
            JsonValue::String(last_used_at),
            JsonValue::String(created_at),
            JsonValue::String(updated_at),
        ],
    )
    .await?
    .ok_or_else(|| DatabaseOperationError::unavailable("Attachment remote ref was not returned"))?;
    transaction
        .commit()
        .await
        .map_err(DatabaseOperationError::from)?;
    Ok(JsonValue::Object(row))
}

pub(super) async fn touch(
    pool: &SqlitePool,
    id: i64,
    last_used_at: Option<String>,
) -> Result<JsonValue, DatabaseOperationError> {
    let last_used_at = last_used_at.unwrap_or(now_iso()?);
    let mut transaction = begin_immediate(pool).await?;
    run(
        &mut *transaction,
        "UPDATE attachment_remote_refs
         SET last_used_at = ?, updated_at = ?
         WHERE id = ?",
        vec![
            JsonValue::String(last_used_at.clone()),
            JsonValue::String(last_used_at),
            JsonValue::Number(id.into()),
        ],
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(DatabaseOperationError::from)?;
    Ok(JsonValue::Null)
}
