// Copyright (c) 2026. 千诚. Licensed under GPL v3.

use std::collections::{BTreeSet, HashMap, HashSet};

use serde_json::{Map as JsonMap, Value as JsonValue};
use sqlx::{SqliteConnection, SqlitePool};

use super::super::operation::DatabaseOperationError;
use super::super::repository::{
    begin_immediate, fetch_one, fetch_rows, json_object, json_row, run,
};
use super::super::row::{count, insert_one};
use super::models::MODEL_WITH_PROVIDER_SELECT;

const SESSION_COLUMNS: &[&str] = &[
    "session_id",
    "title",
    "model",
    "provider_id",
    "last_message_preview",
    "last_message_at",
    "message_count",
    "status_badge_dismissed_turn_id",
    "pinned_at",
    "archived_at",
    "created_at",
    "updated_at",
];

const SESSION_SELECT: &str = "
    SELECT
        sessions.*,
        CASE
            WHEN (
                SELECT latest_session_turns.status
                FROM session_turns latest_session_turns
                WHERE latest_session_turns.session_id = sessions.id
                ORDER BY latest_session_turns.created_at DESC, latest_session_turns.id DESC
                LIMIT 1
            ) IN ('completed', 'failed')
            AND COALESCE((
                SELECT latest_session_turns.id
                FROM session_turns latest_session_turns
                WHERE latest_session_turns.session_id = sessions.id
                ORDER BY latest_session_turns.created_at DESC, latest_session_turns.id DESC
                LIMIT 1
            ), 0) > COALESCE(sessions.status_badge_dismissed_turn_id, 0)
            THEN (
                SELECT latest_session_turns.status
                FROM session_turns latest_session_turns
                WHERE latest_session_turns.session_id = sessions.id
                ORDER BY latest_session_turns.created_at DESC, latest_session_turns.id DESC
                LIMIT 1
            )
            ELSE NULL
        END AS pending_terminal_status
    FROM sessions
";

fn message_text(message_alias: &str) -> String {
    format!(
        "COALESCE((
            SELECT group_concat(content, '') FROM (
                SELECT CASE
                    WHEN part.type = 'text' THEN part.content
                    ELSE COALESCE(json_extract(part.data, '$.output'), '')
                END AS content
                FROM message_parts part
                WHERE part.message_id = {message_alias}.id
                  AND part.type IN ('text', 'tool_call')
                ORDER BY part.sort_order, part.id
            )
        ), '')"
    )
}

fn escape_like_pattern(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '\\' | '%' | '_' => {
                escaped.push('\\');
                escaped.push(character);
            }
            _ => escaped.push(character),
        }
    }
    escaped
}

fn build_session_search_trigram_expression(query: &str) -> Option<String> {
    if query.contains('\0') {
        return None;
    }

    let characters = query.chars().collect::<Vec<_>>();
    if characters.len() < 3 {
        return None;
    }

    let mut starts = BTreeSet::from([0, characters.len() - 3]);
    if characters.len() >= 9 {
        starts.insert((characters.len() - 3) / 2);
    }

    let mut tokens = Vec::new();
    let mut seen = HashSet::new();
    for start in starts {
        if tokens.len() >= 3 {
            break;
        }

        let token = characters[start..start + 3].iter().collect::<String>();
        if seen.insert(token.clone()) {
            tokens.push(format!("\"{}\"", token.replace('"', "\"\"")));
        }
    }

    (!tokens.is_empty()).then(|| tokens.join(" AND "))
}

fn normalized_limit(limit: Option<u32>) -> u32 {
    limit.unwrap_or(40).clamp(1, 1000)
}

pub(super) async fn create(
    pool: &SqlitePool,
    data: JsonMap<String, JsonValue>,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = pool.acquire().await.map_err(DatabaseOperationError::from)?;
    let mut row = insert_one(&mut connection, "sessions", &data, SESSION_COLUMNS).await?;
    row.insert("pending_terminal_status".to_string(), JsonValue::Null);
    Ok(JsonValue::Object(row))
}

pub(super) async fn find_by_id(
    pool: &SqlitePool,
    id: i64,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = pool.acquire().await.map_err(DatabaseOperationError::from)?;
    Ok(json_row(find_by_id_on(&mut connection, id).await?))
}

async fn find_by_id_on(
    connection: &mut SqliteConnection,
    id: i64,
) -> Result<Option<JsonMap<String, JsonValue>>, DatabaseOperationError> {
    fetch_one(
        connection,
        &format!("{SESSION_SELECT} WHERE sessions.id = ?"),
        vec![JsonValue::Number(id.into())],
    )
    .await
}

async fn load_messages_on(
    connection: &mut SqliteConnection,
    session_id: i64,
) -> Result<Vec<JsonValue>, DatabaseOperationError> {
    let message_rows = fetch_rows(
        connection,
        "SELECT * FROM messages WHERE session_id = ? ORDER BY id",
        vec![JsonValue::Number(session_id.into())],
    )
    .await?;
    let part_rows = fetch_rows(
        connection,
        "SELECT message_parts.*
         FROM message_parts
         INNER JOIN messages ON messages.id = message_parts.message_id
         WHERE messages.session_id = ?
         ORDER BY message_parts.message_id, message_parts.sort_order, message_parts.id",
        vec![JsonValue::Number(session_id.into())],
    )
    .await?;
    let attachment_rows = fetch_rows(
        connection,
        "SELECT
             message_parts.message_id,
             message_parts.sort_order,
             attachments.id,
             attachments.hash,
             attachments.type,
             attachments.original_name,
             json_extract(message_parts.data, '$.originPath') AS origin_path,
             json_extract(message_parts.data, '$.toolCallId') AS tool_call_id,
             json_extract(message_parts.data, '$.toolKind') AS tool_kind,
             attachments.mime_type,
             attachments.size,
             attachments.created_at
         FROM message_parts
         INNER JOIN messages ON messages.id = message_parts.message_id
         INNER JOIN attachments ON attachments.id = message_parts.attachment_id
         WHERE messages.session_id = ? AND message_parts.type = 'attachment'
         ORDER BY message_parts.message_id, message_parts.sort_order, message_parts.id",
        vec![JsonValue::Number(session_id.into())],
    )
    .await?;

    let mut parts_by_message: HashMap<i64, Vec<JsonValue>> = HashMap::new();
    for row in part_rows {
        let message_id = row
            .get("message_id")
            .and_then(JsonValue::as_i64)
            .ok_or_else(|| DatabaseOperationError::unavailable("Message part has no message id"))?;
        parts_by_message
            .entry(message_id)
            .or_default()
            .push(JsonValue::Object(row));
    }
    let mut attachments_by_message: HashMap<i64, Vec<JsonValue>> = HashMap::new();
    for row in attachment_rows {
        let message_id = row
            .get("message_id")
            .and_then(JsonValue::as_i64)
            .ok_or_else(|| {
                DatabaseOperationError::unavailable("Message attachment has no message id")
            })?;
        attachments_by_message
            .entry(message_id)
            .or_default()
            .push(JsonValue::Object(row));
    }

    message_rows
        .into_iter()
        .map(|mut row| {
            let message_id = row
                .get("id")
                .and_then(JsonValue::as_i64)
                .ok_or_else(|| DatabaseOperationError::unavailable("Message has no id"))?;
            row.insert(
                "parts".to_string(),
                JsonValue::Array(parts_by_message.remove(&message_id).unwrap_or_default()),
            );
            row.insert(
                "attachments".to_string(),
                JsonValue::Array(
                    attachments_by_message
                        .remove(&message_id)
                        .unwrap_or_default(),
                ),
            );
            Ok(JsonValue::Object(row))
        })
        .collect()
}

fn context_summary_bounds(part: &JsonMap<String, JsonValue>) -> Option<(i64, Vec<i64>)> {
    let message_id = part.get("message_id")?.as_i64()?;
    let data = part.get("data")?.as_str()?;
    let metadata = serde_json::from_str::<JsonMap<String, JsonValue>>(data).ok()?;
    if metadata.get("version")?.as_i64()? != 2
        || metadata
            .get("invalidatedAt")
            .is_some_and(|value| !value.is_null())
        || uuid::Uuid::parse_str(metadata.get("id")?.as_str()?).is_err()
    {
        return None;
    }
    let text = part.get("content")?.as_str()?.trim();
    if text.is_empty() || text.chars().count() > 32_000 {
        return None;
    }
    let first_kept = metadata.get("firstKeptMessageId")?.as_i64()?;
    if first_kept <= 0 || first_kept > message_id {
        return None;
    }
    let system_ids = metadata
        .get("systemMessageIds")?
        .as_array()?
        .iter()
        .map(JsonValue::as_i64)
        .collect::<Option<Vec<_>>>()?;
    let unique = system_ids.iter().copied().collect::<HashSet<_>>();
    if unique.len() != system_ids.len() || system_ids.iter().any(|id| *id >= first_kept) {
        return None;
    }
    Some((first_kept, system_ids))
}

pub(super) async fn find_messages(
    pool: &SqlitePool,
    session_id: i64,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut transaction = pool.begin().await.map_err(DatabaseOperationError::from)?;
    let messages = load_messages_on(&mut *transaction, session_id).await?;
    transaction
        .commit()
        .await
        .map_err(DatabaseOperationError::from)?;
    Ok(JsonValue::Array(messages))
}

pub(super) async fn find_context(
    pool: &SqlitePool,
    session_id: i64,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut transaction = pool.begin().await.map_err(DatabaseOperationError::from)?;
    let summary_part = fetch_one(
        &mut *transaction,
        "SELECT message_parts.*
         FROM messages
         INNER JOIN message_parts ON message_parts.message_id = messages.id
         WHERE messages.session_id = ? AND message_parts.type = 'context_compaction'
         ORDER BY message_parts.id DESC
         LIMIT 1",
        vec![JsonValue::Number(session_id.into())],
    )
    .await?;
    let messages = load_messages_on(&mut *transaction, session_id).await?;
    transaction
        .commit()
        .await
        .map_err(DatabaseOperationError::from)?;

    let valid_summary = summary_part
        .as_ref()
        .and_then(context_summary_bounds)
        .and_then(|(first_kept, system_ids)| {
            let selected = messages
                .iter()
                .filter(|message| {
                    message
                        .get("id")
                        .and_then(JsonValue::as_i64)
                        .is_some_and(|id| id >= first_kept || system_ids.contains(&id))
                })
                .cloned()
                .collect::<Vec<_>>();
            let system_roles_match = selected
                .iter()
                .filter(|message| {
                    message
                        .get("id")
                        .and_then(JsonValue::as_i64)
                        .is_some_and(|id| system_ids.contains(&id))
                })
                .all(|message| message.get("role").and_then(JsonValue::as_str) == Some("system"));
            system_roles_match.then_some(selected)
        });

    let mut result = JsonMap::new();
    result.insert(
        "messages".to_string(),
        JsonValue::Array(valid_summary.clone().unwrap_or(messages)),
    );
    result.insert(
        "summaryPart".to_string(),
        valid_summary
            .and(summary_part)
            .map(JsonValue::Object)
            .unwrap_or(JsonValue::Null),
    );
    Ok(JsonValue::Object(result))
}

pub(super) async fn find_history(
    pool: &SqlitePool,
    session_id: i64,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut transaction = pool.begin().await.map_err(DatabaseOperationError::from)?;
    let session = find_by_id_on(&mut *transaction, session_id)
        .await?
        .ok_or_else(|| {
            DatabaseOperationError::not_found(format!("Session {session_id} not found"))
        })?;
    let messages = load_messages_on(&mut *transaction, session_id).await?;
    let turn_rows = fetch_rows(
        &mut *transaction,
        "SELECT
             id,
             session_id,
             task_id,
             execution_mode,
             prompt_snapshot_json,
             prompt_message_id,
             response_message_id,
             status,
             error_message,
             created_at,
             updated_at
         FROM session_turns
         WHERE session_id = ?
         ORDER BY created_at, id",
        vec![JsonValue::Number(session_id.into())],
    )
    .await?;
    let attempt_rows = fetch_rows(
        &mut *transaction,
        "SELECT
             session_turn_attempts.id,
             session_turn_attempts.turn_id,
             session_turn_attempts.attempt_index,
             session_turn_attempts.max_retries,
             session_turn_attempts.status,
             session_turn_attempts.checkpoint_json,
             session_turn_attempts.delivery_manifest_json,
             session_turn_attempts.error_message,
             session_turn_attempts.started_at,
             session_turn_attempts.finished_at,
             session_turn_attempts.created_at,
             session_turn_attempts.updated_at
         FROM session_turn_attempts
         INNER JOIN session_turns ON session_turns.id = session_turn_attempts.turn_id
         WHERE session_turns.session_id = ?
         ORDER BY session_turn_attempts.turn_id,
                  session_turn_attempts.attempt_index,
                  session_turn_attempts.id",
        vec![JsonValue::Number(session_id.into())],
    )
    .await?;
    let model = fetch_one(
        &mut *transaction,
        &format!(
            "{MODEL_WITH_PROVIDER_SELECT}
             INNER JOIN session_turns ON session_turns.model_id = models.id
             WHERE session_turns.session_id = ?
             ORDER BY session_turns.created_at DESC, session_turns.id DESC
             LIMIT 1"
        ),
        vec![JsonValue::Number(session_id.into())],
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(DatabaseOperationError::from)?;

    let mut result = JsonMap::new();
    result.insert("session".to_string(), JsonValue::Object(session));
    result.insert("messages".to_string(), JsonValue::Array(messages));
    result.insert("turns".to_string(), json_object(turn_rows));
    result.insert("attempts".to_string(), json_object(attempt_rows));
    result.insert(
        "model".to_string(),
        model.map(JsonValue::Object).unwrap_or(JsonValue::Null),
    );
    Ok(JsonValue::Object(result))
}

pub(super) async fn list(
    pool: &SqlitePool,
    query: Option<String>,
    limit: Option<u32>,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = pool.acquire().await.map_err(DatabaseOperationError::from)?;
    let mut params = Vec::new();
    let mut where_clause = String::new();
    let query = query.unwrap_or_default().trim().to_string();

    if !query.is_empty() {
        let pattern = format!("%{}%", escape_like_pattern(&query));
        let text = message_text("searchable_messages");
        let trigram_expression = build_session_search_trigram_expression(&query);
        let fts_clause = if trigram_expression.is_some() {
            " AND searchable_messages.id IN (
                SELECT rowid FROM message_search_fts
                WHERE message_search_fts MATCH ?
            )"
        } else {
            ""
        };
        where_clause = format!(
            " WHERE (
                lower(sessions.title) LIKE lower(?) ESCAPE '\\'
                OR EXISTS (
                    SELECT 1
                    FROM messages searchable_messages
                    WHERE searchable_messages.session_id = sessions.id
                      AND searchable_messages.role IN ('user', 'assistant', 'tool_call')
                      {fts_clause}
                      AND lower({text}) LIKE lower(?) ESCAPE '\\'
                )
            )"
        );
        params.push(JsonValue::String(pattern.clone()));
        if let Some(expression) = trigram_expression {
            params.push(JsonValue::String(expression));
        }
        params.push(JsonValue::String(pattern));
    }

    params.push(JsonValue::Number(normalized_limit(limit).into()));
    let sql = format!(
        "{SESSION_SELECT}{where_clause}
         ORDER BY COALESCE(sessions.last_message_at, sessions.updated_at) DESC, sessions.id DESC
         LIMIT ?"
    );
    Ok(json_object(
        fetch_rows(&mut connection, &sql, params).await?,
    ))
}

pub(super) async fn update(
    pool: &SqlitePool,
    id: i64,
    data: JsonMap<String, JsonValue>,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = pool.acquire().await.map_err(DatabaseOperationError::from)?;
    let mut set_parts = Vec::new();
    for key in data.keys() {
        if !SESSION_COLUMNS.contains(&key.as_str()) {
            return Err(DatabaseOperationError::validation(format!(
                "Unsupported field '{key}'"
            )));
        }
        if key == "updated_at" {
            continue;
        }
        set_parts.push(format!("\"{key}\" = ?"));
    }
    set_parts.push("\"updated_at\" = datetime('now')".to_string());
    let mut params = data
        .iter()
        .filter(|(key, _)| key.as_str() != "updated_at")
        .map(|(_, value)| value.clone())
        .collect::<Vec<JsonValue>>();
    params.push(JsonValue::Number(id.into()));
    let sql = format!(
        "UPDATE sessions SET {} WHERE id = ? RETURNING *",
        set_parts.join(", ")
    );
    let row = fetch_one(&mut connection, &sql, params).await?;
    Ok(json_row(row))
}

pub(super) async fn dismiss_terminal_status(
    pool: &SqlitePool,
    id: i64,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut transaction = begin_immediate(pool).await?;
    let latest = fetch_one(
        &mut *transaction,
        "SELECT id, status FROM session_turns
         WHERE session_id = ?
         ORDER BY created_at DESC, id DESC LIMIT 1",
        vec![JsonValue::Number(id.into())],
    )
    .await?;
    let Some(latest) = latest else {
        return Ok(JsonValue::Null);
    };
    if !matches!(
        latest.get("status").and_then(JsonValue::as_str),
        Some("completed" | "failed")
    ) {
        return Ok(JsonValue::Null);
    }
    run(
        &mut *transaction,
        "UPDATE sessions SET status_badge_dismissed_turn_id = ? WHERE id = ?",
        vec![
            latest.get("id").cloned().unwrap_or(JsonValue::Null),
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

pub(super) async fn refresh_metadata(
    pool: &SqlitePool,
    id: i64,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = pool.acquire().await.map_err(DatabaseOperationError::from)?;
    refresh_metadata_on(&mut connection, id).await?;
    Ok(JsonValue::Null)
}

pub(super) async fn refresh_metadata_on(
    connection: &mut sqlx::SqliteConnection,
    id: i64,
) -> Result<(), DatabaseOperationError> {
    let assistant_text = message_text("assistant_messages");
    let tool_text = message_text("tool_call_messages");
    let user_text = message_text("user_messages");
    let sql = format!(
        "UPDATE sessions
         SET
             message_count = (
                 SELECT count(*) FROM messages counted_messages
                 WHERE counted_messages.session_id = ?
                   AND counted_messages.role IN ('user', 'assistant')
             ),
             last_message_at = COALESCE(
                 (
                     SELECT assistant_messages.created_at
                     FROM messages assistant_messages
                     WHERE assistant_messages.session_id = ?
                       AND assistant_messages.role = 'assistant'
                       AND trim({assistant_text}) <> ''
                     ORDER BY assistant_messages.created_at DESC, assistant_messages.id DESC
                     LIMIT 1
                 ),
                 (
                     SELECT tool_call_messages.created_at
                     FROM messages tool_call_messages
                     WHERE tool_call_messages.session_id = ?
                       AND tool_call_messages.role = 'tool_call'
                       AND trim({tool_text}) <> ''
                     ORDER BY tool_call_messages.created_at DESC, tool_call_messages.id DESC
                     LIMIT 1
                 ),
                 (
                     SELECT user_messages.created_at
                     FROM messages user_messages
                     WHERE user_messages.session_id = ?
                       AND user_messages.role = 'user'
                     ORDER BY user_messages.created_at DESC, user_messages.id DESC
                     LIMIT 1
                 )
             ),
             last_message_preview = COALESCE(
                 (
                     SELECT CASE
                         WHEN length({assistant_text}) > 160
                             THEN substr({assistant_text}, 1, 160) || '...'
                         ELSE {assistant_text}
                     END
                     FROM messages assistant_messages
                     WHERE assistant_messages.session_id = ?
                       AND assistant_messages.role = 'assistant'
                       AND trim({assistant_text}) <> ''
                     ORDER BY assistant_messages.created_at DESC, assistant_messages.id DESC
                     LIMIT 1
                 ),
                 (
                     SELECT CASE
                         WHEN length({tool_text}) > 160
                             THEN substr({tool_text}, 1, 160) || '...'
                         ELSE {tool_text}
                     END
                     FROM messages tool_call_messages
                     WHERE tool_call_messages.session_id = ?
                       AND tool_call_messages.role = 'tool_call'
                       AND trim({tool_text}) <> ''
                     ORDER BY tool_call_messages.created_at DESC, tool_call_messages.id DESC
                     LIMIT 1
                 ),
                 (
                     SELECT CASE
                         WHEN length({user_text}) > 160
                             THEN substr({user_text}, 1, 160) || '...'
                         ELSE {user_text}
                     END
                     FROM messages user_messages
                     WHERE user_messages.session_id = ?
                       AND user_messages.role = 'user'
                     ORDER BY user_messages.created_at DESC, user_messages.id DESC
                     LIMIT 1
                 )
             ),
             provider_id = COALESCE(
                 (
                     SELECT latest_models.provider_id
                     FROM session_turns latest_turns
                     INNER JOIN models latest_models ON latest_models.id = latest_turns.model_id
                     WHERE latest_turns.session_id = ?
                     ORDER BY latest_turns.created_at DESC, latest_turns.id DESC
                     LIMIT 1
                 ),
                 sessions.provider_id
             ),
             updated_at = datetime('now')
         WHERE id = ?"
    );
    let params = vec![
        JsonValue::Number(id.into()),
        JsonValue::Number(id.into()),
        JsonValue::Number(id.into()),
        JsonValue::Number(id.into()),
        JsonValue::Number(id.into()),
        JsonValue::Number(id.into()),
        JsonValue::Number(id.into()),
        JsonValue::Number(id.into()),
        JsonValue::Number(id.into()),
    ];
    run(connection, &sql, params).await?;
    Ok(())
}

pub(super) async fn count_sessions(pool: &SqlitePool) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = pool.acquire().await.map_err(DatabaseOperationError::from)?;
    count_rows(&mut connection, "sessions").await
}

pub(super) async fn delete_all(pool: &SqlitePool) -> Result<JsonValue, DatabaseOperationError> {
    let mut transaction = begin_immediate(pool).await?;
    run(&mut *transaction, "DELETE FROM sessions", Vec::new()).await?;
    transaction
        .commit()
        .await
        .map_err(DatabaseOperationError::from)?;
    Ok(JsonValue::Null)
}

async fn count_rows(
    connection: &mut SqliteConnection,
    table: &'static str,
) -> Result<JsonValue, DatabaseOperationError> {
    Ok(JsonValue::Number(
        count(
            connection,
            &format!("SELECT count(*) AS count FROM {table}"),
            Vec::new(),
        )
        .await?
        .into(),
    ))
}

async fn delete_all_rows(
    pool: &SqlitePool,
    table: &'static str,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut transaction = begin_immediate(pool).await?;
    run(
        &mut *transaction,
        &format!("DELETE FROM {table}"),
        Vec::new(),
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(DatabaseOperationError::from)?;
    Ok(JsonValue::Null)
}

pub(super) async fn count_messages(pool: &SqlitePool) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = pool.acquire().await.map_err(DatabaseOperationError::from)?;
    count_rows(&mut connection, "messages").await
}

pub(super) async fn delete_all_messages(
    pool: &SqlitePool,
) -> Result<JsonValue, DatabaseOperationError> {
    delete_all_rows(pool, "messages").await
}

pub(super) async fn count_session_turns(
    pool: &SqlitePool,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = pool.acquire().await.map_err(DatabaseOperationError::from)?;
    count_rows(&mut connection, "session_turns").await
}

pub(super) async fn delete_all_session_turns(
    pool: &SqlitePool,
) -> Result<JsonValue, DatabaseOperationError> {
    delete_all_rows(pool, "session_turns").await
}

#[cfg(test)]
mod tests {
    use super::build_session_search_trigram_expression;

    #[test]
    fn user_search_narrows_candidates_with_multiple_necessary_trigrams() {
        assert_eq!(
            build_session_search_trigram_expression("abcdefghi").as_deref(),
            Some("\"abc\" AND \"def\" AND \"ghi\"")
        );
    }

    #[test]
    fn user_search_falls_back_when_a_trigram_cannot_be_used() {
        assert_eq!(build_session_search_trigram_expression("ab"), None);
        assert_eq!(build_session_search_trigram_expression("abc\0def"), None);
    }
}
