// Copyright (c) 2026. 千诚. Licensed under GPL v3.

use serde_json::{Map as JsonMap, Value as JsonValue};
use sqlx::SqlitePool;

use super::super::operation::{DatabaseOperationError, ToolPartFilter, ToolPartKind};
use super::super::repository::{fetch_one, fetch_rows};
use super::super::row::insert_one;

fn tool_payload(data: &JsonMap<String, JsonValue>) -> JsonMap<String, JsonValue> {
    let mut payload = data.clone();
    for key in ["message_id", "session_id", "tool_call_id", "created_at"] {
        payload.remove(key);
    }
    if let Some(call_id) = data.get("tool_call_id").and_then(JsonValue::as_str) {
        payload.insert(
            "toolCallId".to_string(),
            JsonValue::String(call_id.to_string()),
        );
    }
    payload
}

fn apply_create_defaults(kind: ToolPartKind, payload: &mut JsonMap<String, JsonValue>) {
    payload
        .entry("iteration")
        .or_insert_with(|| JsonValue::Number(1.into()));
    payload.entry("output").or_insert(JsonValue::Null);
    payload
        .entry("status")
        .or_insert_with(|| JsonValue::String("pending".to_string()));
    payload.entry("duration_ms").or_insert(JsonValue::Null);
    payload.entry("error_message").or_insert(JsonValue::Null);

    if kind == ToolPartKind::Builtin {
        payload
            .entry("approval_state")
            .or_insert_with(|| JsonValue::String("none".to_string()));
        payload.entry("approval_summary").or_insert(JsonValue::Null);
        payload
            .entry("conversation_semantic_json")
            .or_insert(JsonValue::Null);
        payload
            .entry("structured_payload_json")
            .or_insert(JsonValue::Null);
    }
}

fn part_entity(
    part: JsonMap<String, JsonValue>,
    session_id: JsonValue,
) -> Result<JsonMap<String, JsonValue>, DatabaseOperationError> {
    let data = part
        .get("data")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| DatabaseOperationError::unavailable("Tool part data is missing"))?;
    let mut entity = serde_json::from_str::<JsonMap<String, JsonValue>>(data)
        .map_err(|error| DatabaseOperationError::unavailable(error.to_string()))?;
    entity.insert(
        "id".to_string(),
        part.get("id").cloned().unwrap_or(JsonValue::Null),
    );
    entity.insert("session_id".to_string(), session_id);
    entity.insert(
        "message_id".to_string(),
        part.get("message_id").cloned().unwrap_or(JsonValue::Null),
    );
    entity.insert(
        "tool_call_id".to_string(),
        part.get("tool_call_id").cloned().unwrap_or(JsonValue::Null),
    );
    entity.insert(
        "created_at".to_string(),
        part.get("created_at").cloned().unwrap_or(JsonValue::Null),
    );
    Ok(entity)
}

fn filter_clause(
    kind: ToolPartKind,
    filter: &ToolPartFilter,
    params: &mut Vec<JsonValue>,
) -> String {
    params.push(JsonValue::String(kind.as_str().to_string()));
    let predicate = match filter {
        ToolPartFilter::Id { id } => {
            params.push(JsonValue::Number((*id).into()));
            "message_parts.id = ?"
        }
        ToolPartFilter::ToolCallId { tool_call_id } => {
            params.push(JsonValue::String(tool_call_id.clone()));
            "message_parts.tool_call_id = ?"
        }
        ToolPartFilter::ServerId { server_id } => {
            params.push(JsonValue::Number((*server_id).into()));
            "json_extract(message_parts.data, '$.server_id') = ?"
        }
        ToolPartFilter::ToolId { tool_id } => {
            params.push(JsonValue::String(tool_id.clone()));
            "json_extract(message_parts.data, '$.tool_id') = ?"
        }
    };
    format!(
        "WHERE message_parts.type = 'tool_call'
           AND message_parts.tool_kind = ?
           AND {predicate}"
    )
}

pub(super) async fn create(
    pool: &SqlitePool,
    kind: ToolPartKind,
    data: JsonMap<String, JsonValue>,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut transaction = pool.begin().await.map_err(DatabaseOperationError::from)?;
    let message_id = match data.get("message_id").and_then(JsonValue::as_i64) {
        Some(id) if id > 0 => id,
        _ => {
            let session_id = data
                .get("session_id")
                .and_then(JsonValue::as_i64)
                .ok_or_else(|| {
                    DatabaseOperationError::validation("A tool call must belong to a session")
                })?;
            let mut message = JsonMap::new();
            message.insert(
                "session_id".to_string(),
                JsonValue::Number(session_id.into()),
            );
            message.insert(
                "role".to_string(),
                JsonValue::String("tool_call".to_string()),
            );
            let created = insert_one(
                &mut *transaction,
                "messages",
                &message,
                &["session_id", "role"],
            )
            .await?;
            created
                .get("id")
                .and_then(JsonValue::as_i64)
                .ok_or_else(|| {
                    DatabaseOperationError::unavailable("Failed to create tool message")
                })?
        }
    };

    let mut payload = tool_payload(&data);
    apply_create_defaults(kind, &mut payload);
    payload.insert(
        "toolKind".to_string(),
        JsonValue::String(kind.as_str().to_string()),
    );
    let payload = serde_json::to_string(&JsonValue::Object(payload))
        .map_err(|error| DatabaseOperationError::unavailable(error.to_string()))?;
    let created_at = data
        .get("created_at")
        .and_then(JsonValue::as_str)
        .map(|value| JsonValue::String(value.to_string()))
        .unwrap_or(JsonValue::Null);
    let part = fetch_one(
        &mut *transaction,
        "INSERT INTO message_parts (
             message_id, type, content, sort_order, data, created_at
         )
         VALUES (
             ?,
             'tool_call',
             '',
             (
                 SELECT COALESCE(MAX(sort_order), -1) + 1
                 FROM message_parts
                 WHERE message_id = ?
             ),
             ?,
             COALESCE(?, datetime('now'))
         )
         RETURNING *",
        vec![
            JsonValue::Number(message_id.into()),
            JsonValue::Number(message_id.into()),
            JsonValue::String(payload),
            created_at,
        ],
    )
    .await?
    .ok_or_else(|| DatabaseOperationError::unavailable("Failed to persist tool part"))?;
    let parent = fetch_one(
        &mut *transaction,
        "SELECT session_id FROM messages WHERE id = ?",
        vec![JsonValue::Number(message_id.into())],
    )
    .await?
    .ok_or_else(|| DatabaseOperationError::not_found("Tool message not found"))?;
    let session_id = parent.get("session_id").cloned().unwrap_or(JsonValue::Null);
    let entity = part_entity(part, session_id)?;
    transaction
        .commit()
        .await
        .map_err(DatabaseOperationError::from)?;
    Ok(JsonValue::Object(entity))
}

pub(super) async fn list(
    pool: &SqlitePool,
    kind: ToolPartKind,
    filter: ToolPartFilter,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = pool.acquire().await.map_err(DatabaseOperationError::from)?;
    let mut params = Vec::new();
    let where_clause = filter_clause(kind, &filter, &mut params);
    let mut sql = format!(
        "SELECT message_parts.*, messages.session_id
         FROM message_parts
         INNER JOIN messages ON messages.id = message_parts.message_id
         {where_clause}
         ORDER BY message_parts.created_at DESC, message_parts.id DESC"
    );
    if let Some(limit) = limit {
        sql.push_str(" LIMIT ? OFFSET ?");
        params.push(JsonValue::Number(limit.into()));
        params.push(JsonValue::Number(offset.unwrap_or(0).into()));
    } else if let Some(offset) = offset {
        sql.push_str(" LIMIT -1 OFFSET ?");
        params.push(JsonValue::Number(offset.into()));
    }
    let rows = fetch_rows(&mut connection, &sql, params).await?;
    let entities = rows
        .into_iter()
        .map(|row| {
            let session_id = row.get("session_id").cloned().unwrap_or(JsonValue::Null);
            part_entity(row, session_id).map(JsonValue::Object)
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(JsonValue::Array(entities))
}

pub(super) async fn update(
    pool: &SqlitePool,
    kind: ToolPartKind,
    filter: ToolPartFilter,
    data: JsonMap<String, JsonValue>,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut transaction = pool.begin().await.map_err(DatabaseOperationError::from)?;
    let mut params = Vec::new();
    let where_clause = filter_clause(kind, &filter, &mut params);
    let existing = fetch_rows(
        &mut *transaction,
        &format!(
            "SELECT message_parts.*, messages.session_id
             FROM message_parts
             INNER JOIN messages ON messages.id = message_parts.message_id
             {where_clause}
             ORDER BY message_parts.id ASC"
        ),
        params,
    )
    .await?;
    let payload = tool_payload(&data);
    let mut result = None;

    for part in existing {
        let id = part
            .get("id")
            .and_then(JsonValue::as_i64)
            .ok_or_else(|| DatabaseOperationError::unavailable("Tool part id is missing"))?;
        let current = part
            .get("data")
            .and_then(JsonValue::as_str)
            .ok_or_else(|| DatabaseOperationError::unavailable("Tool part data is missing"))?;
        let mut merged = serde_json::from_str::<JsonMap<String, JsonValue>>(current)
            .map_err(|error| DatabaseOperationError::unavailable(error.to_string()))?;
        for (key, value) in &payload {
            merged.insert(key.clone(), value.clone());
        }
        merged.insert(
            "toolKind".to_string(),
            JsonValue::String(kind.as_str().to_string()),
        );
        let serialized = serde_json::to_string(&JsonValue::Object(merged))
            .map_err(|error| DatabaseOperationError::unavailable(error.to_string()))?;
        let updated = fetch_one(
            &mut *transaction,
            "UPDATE message_parts
             SET data = ?, updated_at = datetime('now')
             WHERE id = ?
             RETURNING *",
            vec![JsonValue::String(serialized), JsonValue::Number(id.into())],
        )
        .await?
        .ok_or_else(|| DatabaseOperationError::not_found("Tool part not found"))?;
        if result.is_none() {
            let session_id = part.get("session_id").cloned().unwrap_or(JsonValue::Null);
            result = Some(JsonValue::Object(part_entity(updated, session_id)?));
        }
    }

    transaction
        .commit()
        .await
        .map_err(DatabaseOperationError::from)?;
    Ok(result.unwrap_or(JsonValue::Null))
}
