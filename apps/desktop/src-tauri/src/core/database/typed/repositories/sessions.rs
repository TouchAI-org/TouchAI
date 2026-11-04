// Copyright (c) 2026. 千诚. Licensed under GPL v3.

use std::collections::{BTreeSet, HashSet};

use serde_json::{Map as JsonMap, Value as JsonValue};
use sqlx::SqlitePool;

use super::super::operation::DatabaseOperationError;
use super::super::repository::{fetch_one, fetch_rows, json_object, json_row, run};
use super::super::row::{count, insert_one};

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
    let row = fetch_one(
        &mut connection,
        &format!("{SESSION_SELECT} WHERE sessions.id = ?"),
        vec![JsonValue::Number(id.into())],
    )
    .await?;
    Ok(json_row(row))
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
                "Unsupported column '{key}'"
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
    let mut transaction = pool.begin().await.map_err(DatabaseOperationError::from)?;
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
    run(&mut connection, &sql, params).await?;
    Ok(JsonValue::Null)
}

pub(super) async fn count_sessions(pool: &SqlitePool) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = pool.acquire().await.map_err(DatabaseOperationError::from)?;
    Ok(JsonValue::Number(
        count(
            &mut connection,
            "SELECT count(*) AS count FROM sessions",
            Vec::new(),
        )
        .await?
        .into(),
    ))
}

pub(super) async fn delete_all(pool: &SqlitePool) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = pool.acquire().await.map_err(DatabaseOperationError::from)?;
    run(&mut connection, "DELETE FROM sessions", Vec::new()).await?;
    Ok(JsonValue::Null)
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
