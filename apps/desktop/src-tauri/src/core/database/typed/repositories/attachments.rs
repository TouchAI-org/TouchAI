// Copyright (c) 2026. 千诚. Licensed under GPL v3.

use serde_json::{Map as JsonMap, Value as JsonValue};
use sqlx::SqliteConnection;

use super::super::operation::{AttachmentPersistInput, DatabaseOperationError};
use super::super::repository::{fetch_one, run};

pub(super) async fn ensure(
    connection: &mut SqliteConnection,
    input: &AttachmentPersistInput,
) -> Result<JsonMap<String, JsonValue>, DatabaseOperationError> {
    if !matches!(input.attachment_type.as_str(), "image" | "file") {
        return Err(DatabaseOperationError::validation(
            "Attachment type must be image or file",
        ));
    }
    if let Some(size) = input.size {
        if size < 0 {
            return Err(DatabaseOperationError::validation(
                "Attachment size must not be negative",
            ));
        }
    }

    if let (Some(id), Some(hash)) = (input.attachment_id, input.hash.as_deref()) {
        if hash.trim().is_empty() {
            return Err(DatabaseOperationError::validation(
                "Attachment hash must not be empty",
            ));
        }
        let row = fetch_one(
            connection,
            "SELECT * FROM attachments WHERE id = ?",
            vec![JsonValue::Number(id.into())],
        )
        .await?
        .ok_or_else(|| DatabaseOperationError::not_found("Attachment was not found"))?;
        return Ok(row);
    }

    let hash = input
        .hash
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| DatabaseOperationError::validation("Attachment hash is required"))?;
    let inserted = fetch_one(
        connection,
        "INSERT INTO attachments (
             hash, type, original_name, origin_path, mime_type, size
         )
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(hash) DO NOTHING
         RETURNING *",
        vec![
            JsonValue::String(hash.to_string()),
            JsonValue::String(input.attachment_type.clone()),
            JsonValue::String(input.original_name.clone()),
            JsonValue::String(input.origin_path.clone()),
            input
                .mime_type
                .clone()
                .map(JsonValue::String)
                .unwrap_or(JsonValue::Null),
            input
                .size
                .map(|value| JsonValue::Number(value.into()))
                .unwrap_or(JsonValue::Null),
        ],
    )
    .await?;
    if let Some(row) = inserted {
        return Ok(row);
    }

    fetch_one(
        connection,
        "SELECT * FROM attachments WHERE hash = ?",
        vec![JsonValue::String(hash.to_string())],
    )
    .await?
    .ok_or_else(|| DatabaseOperationError::unavailable("Failed to load attachment"))
}

pub(super) async fn link_to_message(
    connection: &mut SqliteConnection,
    message_id: i64,
    attachment_id: i64,
    origin_path: &str,
    tool_call_id: Option<&str>,
    tool_kind: Option<&str>,
) -> Result<(), DatabaseOperationError> {
    let mut data = JsonMap::new();
    data.insert(
        "attachmentId".to_string(),
        JsonValue::Number(attachment_id.into()),
    );
    data.insert(
        "originPath".to_string(),
        JsonValue::String(origin_path.to_string()),
    );
    if let Some(tool_call_id) = tool_call_id {
        data.insert(
            "toolCallId".to_string(),
            JsonValue::String(tool_call_id.to_string()),
        );
    }
    if let Some(tool_kind) = tool_kind {
        data.insert(
            "toolKind".to_string(),
            JsonValue::String(tool_kind.to_string()),
        );
    }

    run(
        connection,
        "INSERT INTO message_parts (
             message_id, type, content, data, sort_order
         )
         VALUES (
             ?,
             'attachment',
             '',
             ?,
             (
                 SELECT COALESCE(MAX(sort_order), -1) + 1
                 FROM message_parts
                 WHERE message_id = ?
             )
         )",
        vec![
            JsonValue::Number(message_id.into()),
            JsonValue::String(
                serde_json::to_string(&JsonValue::Object(data))
                    .map_err(|error| DatabaseOperationError::unavailable(error.to_string()))?,
            ),
            JsonValue::Number(message_id.into()),
        ],
    )
    .await?;
    Ok(())
}

pub(super) async fn ensure_operation(
    pool: &sqlx::SqlitePool,
    input: AttachmentPersistInput,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = pool.acquire().await.map_err(DatabaseOperationError::from)?;
    Ok(JsonValue::Object(ensure(&mut connection, &input).await?))
}
