// Copyright (c) 2026. 千诚. Licensed under GPL v3.

use std::collections::HashMap;

use serde_json::{Map as JsonMap, Value as JsonValue};
use sha2::{Digest, Sha256};
use sqlx::{SqliteConnection, SqlitePool};

use super::super::operation::{
    AttemptUsageWrite, DatabaseOperationError, OutputPartInput, TaskBeginNextAttemptInput,
    TaskFinishInput, TaskPersistContextSummaryInput, TaskPersistOutputMessageInput,
    TaskPersistToolResultInput, TaskRecordStartInput, TaskUpdateAttemptInput, TurnBehaviorSignals,
};
use super::super::repository::{begin_immediate, fetch_one, fetch_rows, run};
use super::super::row::insert_one;
use super::{attachments, sessions};

const MESSAGE_COLUMNS: &[&str] = &["session_id", "role"];
const MESSAGE_PART_COLUMNS: &[&str] = &[
    "message_id",
    "type",
    "content",
    "data",
    "started_at",
    "ended_at",
    "sort_order",
];
const SESSION_COLUMNS: &[&str] = &[
    "session_id",
    "title",
    "model",
    "provider_id",
    "created_at",
    "updated_at",
];
const TURN_COLUMNS: &[&str] = &[
    "session_id",
    "model_id",
    "task_id",
    "execution_mode",
    "prompt_snapshot_json",
    "prompt_message_id",
    "response_message_id",
    "status",
];
const ATTEMPT_COLUMNS: &[&str] = &[
    "turn_id",
    "attempt_index",
    "max_retries",
    "status",
    "checkpoint_json",
    "delivery_manifest_json",
    "started_at",
    "created_at",
    "updated_at",
];

fn object(entries: impl IntoIterator<Item = (&'static str, JsonValue)>) -> JsonValue {
    let mut map = JsonMap::new();
    for (key, value) in entries {
        map.insert(key.to_string(), value);
    }
    JsonValue::Object(map)
}

fn required_row(
    row: Option<JsonMap<String, JsonValue>>,
    message: &'static str,
) -> Result<JsonMap<String, JsonValue>, DatabaseOperationError> {
    row.ok_or_else(|| DatabaseOperationError::not_found(message))
}

fn validate_role(role: &str) -> Result<(), DatabaseOperationError> {
    if matches!(role, "assistant" | "tool_call") {
        Ok(())
    } else {
        Err(DatabaseOperationError::validation(format!(
            "Unsupported output message role '{role}'"
        )))
    }
}

fn validate_parts(parts: &[OutputPartInput]) -> Result<(), DatabaseOperationError> {
    for part in parts {
        if !matches!(part.part_type.as_str(), "text" | "reasoning") {
            return Err(DatabaseOperationError::validation(format!(
                "Unsupported output part type '{}'",
                part.part_type
            )));
        }
        if part
            .data
            .as_deref()
            .is_some_and(|data| serde_json::from_str::<JsonMap<String, JsonValue>>(data).is_err())
        {
            return Err(DatabaseOperationError::validation(
                "Output part data must be a JSON object",
            ));
        }
    }
    Ok(())
}

async fn sync_output_parts(
    connection: &mut SqliteConnection,
    message_id: i64,
    drafts: &[OutputPartInput],
) -> Result<(), DatabaseOperationError> {
    validate_parts(drafts)?;
    let existing = fetch_rows(
        connection,
        "SELECT * FROM message_parts
         WHERE message_id = ? AND type IN ('text', 'reasoning')",
        vec![JsonValue::Number(message_id.into())],
    )
    .await?;
    let by_order = existing
        .into_iter()
        .filter_map(|row| {
            row.get("sort_order")
                .and_then(JsonValue::as_i64)
                .map(|order| (order, row))
        })
        .collect::<HashMap<_, _>>();

    for (sort_order, draft) in drafts.iter().enumerate() {
        let sort_order = sort_order as i64;
        let part_data = draft.data.clone().unwrap_or_else(|| "{}".to_string());
        if let Some(previous) = by_order.get(&sort_order) {
            let unchanged = previous.get("type").and_then(JsonValue::as_str)
                == Some(draft.part_type.as_str())
                && previous.get("content").and_then(JsonValue::as_str)
                    == Some(draft.content.as_str())
                && previous.get("started_at").and_then(JsonValue::as_i64) == draft.started_at
                && previous.get("ended_at").and_then(JsonValue::as_i64) == draft.ended_at
                && previous.get("data").and_then(JsonValue::as_str) == Some(part_data.as_str());
            if unchanged {
                continue;
            }
            run(
                connection,
                "UPDATE message_parts
                 SET type = ?, content = ?, data = ?, started_at = ?, ended_at = ?,
                     updated_at = datetime('now')
                 WHERE id = ?",
                vec![
                    JsonValue::String(draft.part_type.clone()),
                    JsonValue::String(draft.content.clone()),
                    JsonValue::String(part_data),
                    draft
                        .started_at
                        .map(|value| JsonValue::Number(value.into()))
                        .unwrap_or(JsonValue::Null),
                    draft
                        .ended_at
                        .map(|value| JsonValue::Number(value.into()))
                        .unwrap_or(JsonValue::Null),
                    previous.get("id").cloned().unwrap_or(JsonValue::Null),
                ],
            )
            .await?;
            continue;
        }

        let mut row = JsonMap::new();
        row.insert(
            "message_id".to_string(),
            JsonValue::Number(message_id.into()),
        );
        row.insert(
            "type".to_string(),
            JsonValue::String(draft.part_type.clone()),
        );
        row.insert(
            "content".to_string(),
            JsonValue::String(draft.content.clone()),
        );
        row.insert("data".to_string(), JsonValue::String(part_data));
        row.insert(
            "started_at".to_string(),
            draft
                .started_at
                .map(|value| JsonValue::Number(value.into()))
                .unwrap_or(JsonValue::Null),
        );
        row.insert(
            "ended_at".to_string(),
            draft
                .ended_at
                .map(|value| JsonValue::Number(value.into()))
                .unwrap_or(JsonValue::Null),
        );
        row.insert(
            "sort_order".to_string(),
            JsonValue::Number(sort_order.into()),
        );
        insert_one(connection, "message_parts", &row, MESSAGE_PART_COLUMNS).await?;
    }

    let retained = drafts.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
    let mut params = vec![JsonValue::Number(message_id.into())];
    for index in 0..drafts.len() {
        params.push(JsonValue::Number((index as i64).into()));
    }
    let predicate = if drafts.is_empty() {
        String::new()
    } else {
        format!(" AND sort_order NOT IN ({retained})")
    };
    run(
        connection,
        &format!(
            "DELETE FROM message_parts
             WHERE message_id = ? AND type IN ('text', 'reasoning'){predicate}"
        ),
        params,
    )
    .await?;
    Ok(())
}

async fn write_output_message(
    connection: &mut SqliteConnection,
    session_id: i64,
    role: &str,
    message_id: Option<i64>,
    parts: &[OutputPartInput],
) -> Result<JsonMap<String, JsonValue>, DatabaseOperationError> {
    validate_role(role)?;
    validate_parts(parts)?;
    let message_id = if let Some(message_id) = message_id {
        run(
            connection,
            "UPDATE messages SET role = ?, updated_at = datetime('now') WHERE id = ?",
            vec![
                JsonValue::String(role.to_string()),
                JsonValue::Number(message_id.into()),
            ],
        )
        .await?;
        message_id
    } else {
        let mut message = JsonMap::new();
        message.insert(
            "session_id".to_string(),
            JsonValue::Number(session_id.into()),
        );
        message.insert("role".to_string(), JsonValue::String(role.to_string()));
        let created = insert_one(connection, "messages", &message, MESSAGE_COLUMNS).await?;
        created
            .get("id")
            .and_then(JsonValue::as_i64)
            .ok_or_else(|| DatabaseOperationError::unavailable("Failed to create message"))?
    };

    if !parts.is_empty() {
        sync_output_parts(connection, message_id, parts).await?;
    }
    sessions::refresh_metadata_on(connection, session_id).await?;
    required_row(
        fetch_one(
            connection,
            "SELECT * FROM messages WHERE id = ?",
            vec![JsonValue::Number(message_id.into())],
        )
        .await?,
        "Message was not found",
    )
}

async fn write_llm_call_parts(
    connection: &mut SqliteConnection,
    message_id: i64,
    calls: &[super::super::operation::LlmCallPartInput],
) -> Result<(), DatabaseOperationError> {
    if calls.is_empty() {
        return Ok(());
    }
    let maximum = fetch_one(
        connection,
        "SELECT COALESCE(MAX(sort_order), -1) AS value
         FROM message_parts WHERE message_id = ?",
        vec![JsonValue::Number(message_id.into())],
    )
    .await?
    .and_then(|row| row.get("value").and_then(JsonValue::as_i64))
    .unwrap_or(-1);

    for (index, call) in calls.iter().enumerate() {
        serde_json::from_str::<JsonMap<String, JsonValue>>(&call.data).map_err(|error| {
            DatabaseOperationError::validation(format!(
                "LLM call part data must be a JSON object: {error}"
            ))
        })?;
        let mut part = JsonMap::new();
        part.insert(
            "message_id".to_string(),
            JsonValue::Number(message_id.into()),
        );
        part.insert(
            "type".to_string(),
            JsonValue::String("llm_call".to_string()),
        );
        part.insert("content".to_string(), JsonValue::String(String::new()));
        part.insert("data".to_string(), JsonValue::String(call.data.clone()));
        part.insert(
            "started_at".to_string(),
            call.started_at
                .map(|value| JsonValue::Number(value.into()))
                .unwrap_or(JsonValue::Null),
        );
        part.insert(
            "ended_at".to_string(),
            call.ended_at
                .map(|value| JsonValue::Number(value.into()))
                .unwrap_or(JsonValue::Null),
        );
        part.insert(
            "sort_order".to_string(),
            JsonValue::Number((maximum + 1 + index as i64).into()),
        );
        insert_one(connection, "message_parts", &part, MESSAGE_PART_COLUMNS).await?;
    }
    Ok(())
}

async fn update_attempt_usage(
    connection: &mut SqliteConnection,
    attempt_id: i64,
    usage: &AttemptUsageWrite,
) -> Result<(), DatabaseOperationError> {
    run(
        connection,
        "UPDATE session_turn_attempts
         SET input_tokens = ?, output_tokens = ?, cache_read_tokens = ?,
             cache_write_tokens = ?, reasoning_tokens = ?, total_cost_micros = ?,
             unpriced_calls = ?, ttft_ms = ?, llm_call_count = ?,
             updated_at = datetime('now')
         WHERE id = ?",
        vec![
            JsonValue::Number(usage.summary.input_tokens.into()),
            JsonValue::Number(usage.summary.output_tokens.into()),
            JsonValue::Number(usage.summary.cache_read_tokens.into()),
            JsonValue::Number(usage.summary.cache_write_tokens.into()),
            JsonValue::Number(usage.summary.reasoning_tokens.into()),
            JsonValue::Number(usage.summary.total_cost_micros.into()),
            JsonValue::Number(usage.summary.unpriced_calls.into()),
            usage
                .summary
                .ttft_ms
                .map(|value| JsonValue::Number(value.into()))
                .unwrap_or(JsonValue::Null),
            JsonValue::Number(usage.summary.llm_call_count.into()),
            JsonValue::Number(attempt_id.into()),
        ],
    )
    .await?;
    Ok(())
}

async fn finish_attempt(
    connection: &mut SqliteConnection,
    attempt_id: i64,
    status: &str,
    error_message: Option<&str>,
    duration_ms: Option<i64>,
    finished_at: &str,
) -> Result<(), DatabaseOperationError> {
    run(
        connection,
        "UPDATE session_turn_attempts
         SET status = ?, error_message = ?, duration_ms = ?, finished_at = ?,
             updated_at = ?
         WHERE id = ?",
        vec![
            JsonValue::String(status.to_string()),
            error_message
                .map(|value| JsonValue::String(value.to_string()))
                .unwrap_or(JsonValue::Null),
            duration_ms
                .map(|value| JsonValue::Number(value.into()))
                .unwrap_or(JsonValue::Null),
            JsonValue::String(finished_at.to_string()),
            JsonValue::String(finished_at.to_string()),
            JsonValue::Number(attempt_id.into()),
        ],
    )
    .await?;
    Ok(())
}

async fn finish_turn(
    connection: &mut SqliteConnection,
    input: &TaskFinishInput,
    turn_id: i64,
    assistant_message_id: Option<i64>,
) -> Result<(), DatabaseOperationError> {
    let tokens_used = if input.status == "completed" {
        "tokens_used = ?, "
    } else {
        ""
    };
    let mut params = vec![
        JsonValue::String(input.status.clone()),
        input
            .error_message
            .clone()
            .map(JsonValue::String)
            .unwrap_or(JsonValue::Null),
        assistant_message_id
            .map(|value| JsonValue::Number(value.into()))
            .unwrap_or(JsonValue::Null),
    ];
    if input.status == "completed" {
        params.push(
            input
                .tokens_used
                .map(|value| JsonValue::Number(value.into()))
                .unwrap_or(JsonValue::Null),
        );
    }
    params.push(
        input
            .duration_ms
            .map(|value| JsonValue::Number(value.into()))
            .unwrap_or(JsonValue::Null),
    );
    params.push(JsonValue::Number(turn_id.into()));

    run(
        connection,
        &format!(
            "UPDATE session_turns
             SET status = ?, error_message = ?, response_message_id = ?,
                 {tokens_used}duration_ms = ?, updated_at = datetime('now')
             WHERE id = ?"
        ),
        params,
    )
    .await?;
    Ok(())
}

async fn recompute_turn_usage(
    connection: &mut SqliteConnection,
    turn_id: i64,
    behavior: &TurnBehaviorSignals,
) -> Result<(), DatabaseOperationError> {
    run(
        connection,
        "UPDATE session_turns
         SET input_tokens = (SELECT COALESCE(SUM(input_tokens), 0) FROM session_turn_attempts WHERE turn_id = ?),
             output_tokens = (SELECT COALESCE(SUM(output_tokens), 0) FROM session_turn_attempts WHERE turn_id = ?),
             cache_read_tokens = (SELECT COALESCE(SUM(cache_read_tokens), 0) FROM session_turn_attempts WHERE turn_id = ?),
             cache_write_tokens = (SELECT COALESCE(SUM(cache_write_tokens), 0) FROM session_turn_attempts WHERE turn_id = ?),
             reasoning_tokens = (SELECT COALESCE(SUM(reasoning_tokens), 0) FROM session_turn_attempts WHERE turn_id = ?),
             total_cost_micros = (SELECT COALESCE(SUM(total_cost_micros), 0) FROM session_turn_attempts WHERE turn_id = ?),
             unpriced_calls = (SELECT COALESCE(SUM(unpriced_calls), 0) FROM session_turn_attempts WHERE turn_id = ?),
             llm_call_count = (SELECT COALESCE(SUM(llm_call_count), 0) FROM session_turn_attempts WHERE turn_id = ?),
             ttft_ms = (
                 SELECT ttft_ms FROM session_turn_attempts
                 WHERE turn_id = ? AND ttft_ms IS NOT NULL
                 ORDER BY attempt_index LIMIT 1
             ),
             first_text_ms = ?,
             tool_call_count = ?,
             tool_argument_error_count = ?,
             model_switch_count = ?,
             hit_iteration_ceiling = ?,
             error_code = ?,
             retry_scope = ?,
             updated_at = datetime('now')
         WHERE id = ?",
        vec![
            JsonValue::Number(turn_id.into()),
            JsonValue::Number(turn_id.into()),
            JsonValue::Number(turn_id.into()),
            JsonValue::Number(turn_id.into()),
            JsonValue::Number(turn_id.into()),
            JsonValue::Number(turn_id.into()),
            JsonValue::Number(turn_id.into()),
            JsonValue::Number(turn_id.into()),
            JsonValue::Number(turn_id.into()),
            behavior
                .first_text_ms
                .map(|value| JsonValue::Number(value.into()))
                .unwrap_or(JsonValue::Null),
            JsonValue::Number(behavior.tool_call_count.into()),
            JsonValue::Number(behavior.tool_argument_error_count.into()),
            JsonValue::Number(behavior.model_switch_count.into()),
            JsonValue::Number(i64::from(behavior.hit_iteration_ceiling).into()),
            behavior
                .error_code
                .clone()
                .map(JsonValue::String)
                .unwrap_or(JsonValue::Null),
            behavior
                .retry_scope
                .clone()
                .map(JsonValue::String)
                .unwrap_or(JsonValue::Null),
            JsonValue::Number(turn_id.into()),
        ],
    )
    .await?;
    Ok(())
}

async fn link_attachments(
    connection: &mut SqliteConnection,
    message_id: i64,
    input: &TaskRecordStartInput,
) -> Result<(), DatabaseOperationError> {
    for attachment in &input.attachments {
        let row = attachments::ensure(connection, attachment).await?;
        let attachment_id = row
            .get("id")
            .and_then(JsonValue::as_i64)
            .ok_or_else(|| DatabaseOperationError::unavailable("Attachment id is missing"))?;
        attachments::link_to_message(
            connection,
            message_id,
            attachment_id,
            &attachment.origin_path,
            None,
            None,
        )
        .await?;
    }
    Ok(())
}

pub(super) async fn record_start(
    pool: &SqlitePool,
    input: TaskRecordStartInput,
) -> Result<JsonValue, DatabaseOperationError> {
    if !matches!(input.execution_mode.as_str(), "foreground" | "background") {
        return Err(DatabaseOperationError::validation(
            "Execution mode must be foreground or background",
        ));
    }
    let mut transaction = begin_immediate(pool).await?;

    let session_id = if let Some(session_id) = input.session_id {
        if let Err(error) = run(
            &mut *transaction,
            "UPDATE sessions
             SET model = ?, provider_id = ?, updated_at = datetime('now')
             WHERE id = ?",
            vec![
                JsonValue::String(input.model_name.clone()),
                JsonValue::Number(input.provider_id.into()),
                JsonValue::Number(session_id.into()),
            ],
        )
        .await
        {
            log::warn!("Failed to synchronize session identity: {}", error.message);
        }
        session_id
    } else {
        let mut session = JsonMap::new();
        session.insert(
            "session_id".to_string(),
            JsonValue::String(uuid::Uuid::new_v4().to_string()),
        );
        session.insert(
            "title".to_string(),
            JsonValue::String(input.session_title.clone()),
        );
        session.insert(
            "model".to_string(),
            JsonValue::String(input.model_name.clone()),
        );
        session.insert(
            "provider_id".to_string(),
            JsonValue::Number(input.provider_id.into()),
        );
        let created = insert_one(&mut *transaction, "sessions", &session, SESSION_COLUMNS).await?;
        created
            .get("id")
            .and_then(JsonValue::as_i64)
            .ok_or_else(|| DatabaseOperationError::unavailable("Failed to create session"))?
    };

    let user_message_id = if let Some(message_id) = input.existing_user_message_id {
        required_row(
            fetch_one(
                &mut *transaction,
                "SELECT * FROM messages WHERE id = ?",
                vec![JsonValue::Number(message_id.into())],
            )
            .await?,
            "Prompt message was not found",
        )?;
        message_id
    } else {
        let mut message = JsonMap::new();
        message.insert(
            "session_id".to_string(),
            JsonValue::Number(session_id.into()),
        );
        message.insert("role".to_string(), JsonValue::String("user".to_string()));
        let created = insert_one(&mut *transaction, "messages", &message, MESSAGE_COLUMNS).await?;
        let message_id = created
            .get("id")
            .and_then(JsonValue::as_i64)
            .ok_or_else(|| DatabaseOperationError::unavailable("Failed to create prompt"))?;
        if !input.prompt.is_empty() {
            let mut part = JsonMap::new();
            part.insert(
                "message_id".to_string(),
                JsonValue::Number(message_id.into()),
            );
            part.insert("type".to_string(), JsonValue::String("text".to_string()));
            part.insert(
                "content".to_string(),
                JsonValue::String(input.prompt.clone()),
            );
            part.insert("sort_order".to_string(), JsonValue::Number(0.into()));
            insert_one(
                &mut *transaction,
                "message_parts",
                &part,
                MESSAGE_PART_COLUMNS,
            )
            .await?;
        }
        link_attachments(&mut transaction, message_id, &input).await?;
        sessions::refresh_metadata_on(&mut transaction, session_id).await?;
        message_id
    };

    let turn = if let Some(turn_id) = input.existing_turn_id {
        required_row(
            fetch_one(
                &mut *transaction,
                "SELECT * FROM session_turns WHERE id = ?",
                vec![JsonValue::Number(turn_id.into())],
            )
            .await?,
            "Session turn was not found",
        )?
    } else {
        let mut turn = JsonMap::new();
        turn.insert(
            "session_id".to_string(),
            JsonValue::Number(session_id.into()),
        );
        turn.insert(
            "model_id".to_string(),
            JsonValue::Number(input.model_id.into()),
        );
        turn.insert(
            "task_id".to_string(),
            JsonValue::String(input.task_id.clone()),
        );
        turn.insert(
            "execution_mode".to_string(),
            JsonValue::String(input.execution_mode.clone()),
        );
        turn.insert(
            "prompt_snapshot_json".to_string(),
            JsonValue::String(input.prompt_snapshot_json.clone()),
        );
        turn.insert(
            "prompt_message_id".to_string(),
            JsonValue::Number(user_message_id.into()),
        );
        turn.insert("response_message_id".to_string(), JsonValue::Null);
        turn.insert(
            "status".to_string(),
            JsonValue::String("streaming".to_string()),
        );
        insert_one(&mut *transaction, "session_turns", &turn, TURN_COLUMNS).await?
    };
    let turn_id = turn
        .get("id")
        .and_then(JsonValue::as_i64)
        .ok_or_else(|| DatabaseOperationError::unavailable("Session turn id is missing"))?;

    if let Some(breakdown) = input.prompt_breakdown_json.as_deref() {
        run(
            &mut *transaction,
            "UPDATE session_turns SET prompt_breakdown_json = ?, updated_at = datetime('now') WHERE id = ?",
            vec![
                JsonValue::String(breakdown.to_string()),
                JsonValue::Number(turn_id.into()),
            ],
        )
        .await?;
    }

    let attempt = if let Some(attempt_id) = input.existing_attempt_id {
        required_row(
            fetch_one(
                &mut *transaction,
                "SELECT * FROM session_turn_attempts WHERE id = ? AND turn_id = ?",
                vec![
                    JsonValue::Number(attempt_id.into()),
                    JsonValue::Number(turn_id.into()),
                ],
            )
            .await?,
            "Session turn attempt was not found",
        )?
    } else {
        let mut attempt = JsonMap::new();
        attempt.insert("turn_id".to_string(), JsonValue::Number(turn_id.into()));
        attempt.insert("attempt_index".to_string(), JsonValue::Number(1.into()));
        attempt.insert(
            "max_retries".to_string(),
            JsonValue::Number(input.max_retries.into()),
        );
        attempt.insert(
            "status".to_string(),
            JsonValue::String("streaming".to_string()),
        );
        attempt.insert(
            "checkpoint_json".to_string(),
            JsonValue::String(input.checkpoint_json.clone()),
        );
        attempt.insert(
            "delivery_manifest_json".to_string(),
            JsonValue::String(input.delivery_manifest_json.clone()),
        );
        attempt.insert(
            "started_at".to_string(),
            JsonValue::String(input.started_at.clone()),
        );
        attempt.insert(
            "created_at".to_string(),
            JsonValue::String(input.started_at.clone()),
        );
        attempt.insert(
            "updated_at".to_string(),
            JsonValue::String(input.started_at.clone()),
        );
        insert_one(
            &mut *transaction,
            "session_turn_attempts",
            &attempt,
            ATTEMPT_COLUMNS,
        )
        .await?
    };

    transaction
        .commit()
        .await
        .map_err(DatabaseOperationError::from)?;
    Ok(object([
        ("session_id", JsonValue::Number(session_id.into())),
        ("user_message_id", JsonValue::Number(user_message_id.into())),
        ("turn", JsonValue::Object(turn)),
        ("attempt", JsonValue::Object(attempt)),
    ]))
}

pub(super) async fn persist_output_message(
    pool: &SqlitePool,
    input: TaskPersistOutputMessageInput,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut transaction = begin_immediate(pool).await?;
    let message = write_output_message(
        &mut transaction,
        input.session_id,
        &input.role,
        input.message_id,
        &input.parts,
    )
    .await?;
    let message_id = message
        .get("id")
        .and_then(JsonValue::as_i64)
        .ok_or_else(|| DatabaseOperationError::unavailable("Message id is missing"))?;

    let turn = if input.link_turn {
        let turn_id = input.turn_id.ok_or_else(|| {
            DatabaseOperationError::validation("Turn id is required when linking output")
        })?;
        run(
            &mut *transaction,
            "UPDATE session_turns
             SET response_message_id = ?, updated_at = datetime('now')
             WHERE id = ?",
            vec![
                JsonValue::Number(message_id.into()),
                JsonValue::Number(turn_id.into()),
            ],
        )
        .await?;
        JsonValue::Object(required_row(
            fetch_one(
                &mut *transaction,
                "SELECT * FROM session_turns WHERE id = ?",
                vec![JsonValue::Number(turn_id.into())],
            )
            .await?,
            "Session turn was not found",
        )?)
    } else {
        JsonValue::Null
    };

    transaction
        .commit()
        .await
        .map_err(DatabaseOperationError::from)?;
    Ok(object([
        ("message", JsonValue::Object(message)),
        ("turn", turn),
    ]))
}

pub(super) async fn persist_tool_result(
    pool: &SqlitePool,
    input: TaskPersistToolResultInput,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut transaction = begin_immediate(pool).await?;
    let mut part = if let Some(part_id) = input.tool_call_part_id {
        fetch_one(
            &mut *transaction,
            "SELECT message_parts.*, messages.session_id
             FROM message_parts
             INNER JOIN messages ON messages.id = message_parts.message_id
             WHERE message_parts.id = ? AND message_parts.type = 'tool_call'",
            vec![JsonValue::Number(part_id.into())],
        )
        .await?
    } else if let (Some(tool_call_id), Some(message_id)) =
        (input.tool_call_id.as_deref(), input.tool_call_message_id)
    {
        fetch_one(
            &mut *transaction,
            "SELECT message_parts.*, messages.session_id
             FROM message_parts
             INNER JOIN messages ON messages.id = message_parts.message_id
             WHERE message_parts.type = 'tool_call'
               AND message_parts.tool_call_id = ?
               AND message_parts.message_id = ?
             ORDER BY message_parts.id LIMIT 1",
            vec![
                JsonValue::String(tool_call_id.to_string()),
                JsonValue::Number(message_id.into()),
            ],
        )
        .await?
    } else {
        None
    };

    let Some(existing) = part.take() else {
        transaction
            .commit()
            .await
            .map_err(DatabaseOperationError::from)?;
        return Ok(object([("part", JsonValue::Null)]));
    };
    let part_id = existing
        .get("id")
        .and_then(JsonValue::as_i64)
        .ok_or_else(|| DatabaseOperationError::unavailable("Tool part id is missing"))?;
    let message_id = existing
        .get("message_id")
        .and_then(JsonValue::as_i64)
        .ok_or_else(|| DatabaseOperationError::unavailable("Tool message id is missing"))?;
    let session_id = existing
        .get("session_id")
        .and_then(JsonValue::as_i64)
        .ok_or_else(|| DatabaseOperationError::unavailable("Tool session id is missing"))?;
    let current = existing
        .get("data")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| DatabaseOperationError::unavailable("Tool part data is missing"))?;
    let mut data = serde_json::from_str::<JsonMap<String, JsonValue>>(current)
        .map_err(|error| DatabaseOperationError::unavailable(error.to_string()))?;
    data.insert(
        "output".to_string(),
        JsonValue::String(input.result.clone()),
    );
    let updated = required_row(
        fetch_one(
            &mut *transaction,
            "UPDATE message_parts
             SET data = ?, updated_at = datetime('now')
             WHERE id = ?
             RETURNING *",
            vec![
                JsonValue::String(
                    serde_json::to_string(&JsonValue::Object(data))
                        .map_err(|error| DatabaseOperationError::unavailable(error.to_string()))?,
                ),
                JsonValue::Number(part_id.into()),
            ],
        )
        .await?,
        "Tool part was not found",
    )?;

    let tool_call_id = existing.get("tool_call_id").and_then(JsonValue::as_str);
    let tool_kind = existing.get("tool_kind").and_then(JsonValue::as_str);
    for attachment in &input.attachments {
        let row = attachments::ensure(&mut transaction, attachment).await?;
        let attachment_id = row
            .get("id")
            .and_then(JsonValue::as_i64)
            .ok_or_else(|| DatabaseOperationError::unavailable("Attachment id is missing"))?;
        attachments::link_to_message(
            &mut transaction,
            message_id,
            attachment_id,
            &attachment.origin_path,
            tool_call_id,
            tool_kind,
        )
        .await?;
    }
    sessions::refresh_metadata_on(&mut transaction, session_id).await?;

    transaction
        .commit()
        .await
        .map_err(DatabaseOperationError::from)?;
    Ok(object([("part", JsonValue::Object(updated))]))
}

pub(super) async fn update_attempt(
    pool: &SqlitePool,
    input: TaskUpdateAttemptInput,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut transaction = begin_immediate(pool).await?;
    let mut assignments = Vec::new();
    let mut params = Vec::new();
    if let Some(checkpoint) = input.checkpoint_json {
        assignments.push("checkpoint_json = ?");
        params.push(JsonValue::String(checkpoint));
    }
    if let Some(manifest) = input.delivery_manifest_json {
        assignments.push("delivery_manifest_json = ?");
        params.push(JsonValue::String(manifest));
    }
    if assignments.is_empty() {
        return Err(DatabaseOperationError::validation(
            "At least one attempt field is required",
        ));
    }
    assignments.push("updated_at = datetime('now')");
    params.push(JsonValue::Number(input.attempt_id.into()));
    run(
        &mut *transaction,
        &format!(
            "UPDATE session_turn_attempts SET {} WHERE id = ?",
            assignments.join(", ")
        ),
        params,
    )
    .await?;
    let attempt = required_row(
        fetch_one(
            &mut *transaction,
            "SELECT * FROM session_turn_attempts WHERE id = ?",
            vec![JsonValue::Number(input.attempt_id.into())],
        )
        .await?,
        "Session turn attempt was not found",
    )?;
    transaction
        .commit()
        .await
        .map_err(DatabaseOperationError::from)?;
    Ok(JsonValue::Object(attempt))
}

async fn ensure_finish_turn(
    connection: &mut SqliteConnection,
    input: &TaskFinishInput,
) -> Result<i64, DatabaseOperationError> {
    if let Some(turn_id) = input.turn_id {
        return Ok(turn_id);
    }
    let bootstrap = input.turn_bootstrap.as_ref().ok_or_else(|| {
        DatabaseOperationError::validation(
            "A turn bootstrap is required when finishing without a turn id",
        )
    })?;
    if !matches!(
        bootstrap.execution_mode.as_str(),
        "foreground" | "background"
    ) {
        return Err(DatabaseOperationError::validation(
            "Execution mode must be foreground or background",
        ));
    }
    let mut turn = JsonMap::new();
    turn.insert(
        "session_id".to_string(),
        JsonValue::Number(input.session_id.into()),
    );
    turn.insert(
        "model_id".to_string(),
        JsonValue::Number(bootstrap.model_id.into()),
    );
    turn.insert(
        "task_id".to_string(),
        JsonValue::String(bootstrap.task_id.clone()),
    );
    turn.insert(
        "execution_mode".to_string(),
        JsonValue::String(bootstrap.execution_mode.clone()),
    );
    turn.insert(
        "prompt_snapshot_json".to_string(),
        JsonValue::String(bootstrap.prompt_snapshot_json.clone()),
    );
    turn.insert(
        "prompt_message_id".to_string(),
        bootstrap
            .prompt_message_id
            .map(|value| JsonValue::Number(value.into()))
            .unwrap_or(JsonValue::Null),
    );
    turn.insert("response_message_id".to_string(), JsonValue::Null);
    turn.insert(
        "status".to_string(),
        JsonValue::String("streaming".to_string()),
    );
    let created = insert_one(connection, "session_turns", &turn, TURN_COLUMNS).await?;
    created
        .get("id")
        .and_then(JsonValue::as_i64)
        .ok_or_else(|| DatabaseOperationError::unavailable("Session turn id is missing"))
}

pub(super) async fn finish(
    pool: &SqlitePool,
    input: TaskFinishInput,
) -> Result<JsonValue, DatabaseOperationError> {
    if !matches!(input.status.as_str(), "completed" | "failed" | "cancelled") {
        return Err(DatabaseOperationError::validation(
            "Turn status must be completed, failed, or cancelled",
        ));
    }
    let mut transaction = begin_immediate(pool).await?;
    let turn_id = ensure_finish_turn(&mut transaction, &input).await?;
    let should_write_message = input.assistant_message_id.is_none()
        && (input.parts.as_ref().is_some_and(|parts| !parts.is_empty())
            || input.pending_message_id.is_some());
    let assistant_message_id = if should_write_message {
        let parts = input.parts.as_deref().unwrap_or_default();
        let message = write_output_message(
            &mut transaction,
            input.session_id,
            "assistant",
            input.pending_message_id,
            parts,
        )
        .await?;
        Some(
            message
                .get("id")
                .and_then(JsonValue::as_i64)
                .ok_or_else(|| DatabaseOperationError::unavailable("Message id is missing"))?,
        )
    } else {
        input.assistant_message_id.or(input.pending_message_id)
    };

    if let Some(usage) = &input.usage {
        if let Some(attempt_id) = input.attempt_id {
            update_attempt_usage(&mut transaction, attempt_id, usage).await?;
        }
        if let Some(message_id) = assistant_message_id {
            write_llm_call_parts(&mut transaction, message_id, &usage.calls).await?;
        }
    }
    if let Some(attempt_id) = input.attempt_id {
        finish_attempt(
            &mut transaction,
            attempt_id,
            &input.status,
            input.error_message.as_deref(),
            input.duration_ms,
            &input.finished_at,
        )
        .await?;
    }
    finish_turn(&mut transaction, &input, turn_id, assistant_message_id).await?;
    if input.usage.is_some() {
        recompute_turn_usage(&mut transaction, turn_id, &input.behavior).await?;
    }

    let attempt = if let Some(attempt_id) = input.attempt_id {
        Some(required_row(
            fetch_one(
                &mut *transaction,
                "SELECT * FROM session_turn_attempts WHERE id = ?",
                vec![JsonValue::Number(attempt_id.into())],
            )
            .await?,
            "Session turn attempt was not found",
        )?)
    } else {
        None
    };
    let turn = required_row(
        fetch_one(
            &mut *transaction,
            "SELECT * FROM session_turns WHERE id = ?",
            vec![JsonValue::Number(turn_id.into())],
        )
        .await?,
        "Session turn was not found",
    )?;

    transaction
        .commit()
        .await
        .map_err(DatabaseOperationError::from)?;
    Ok(object([
        (
            "assistant_message_id",
            assistant_message_id
                .map(|value| JsonValue::Number(value.into()))
                .unwrap_or(JsonValue::Null),
        ),
        ("turn", JsonValue::Object(turn)),
        (
            "attempt",
            attempt.map(JsonValue::Object).unwrap_or(JsonValue::Null),
        ),
    ]))
}

pub(super) async fn begin_next_attempt(
    pool: &SqlitePool,
    input: TaskBeginNextAttemptInput,
) -> Result<JsonValue, DatabaseOperationError> {
    if input.attempt_index != input.current_attempt_index + 1 {
        return Err(DatabaseOperationError::validation(
            "Attempt index must follow the current attempt",
        ));
    }
    let mut transaction = begin_immediate(pool).await?;
    if let Some(usage) = &input.usage {
        update_attempt_usage(&mut transaction, input.current_attempt_id, usage).await?;
    }
    finish_attempt(
        &mut transaction,
        input.current_attempt_id,
        "failed",
        Some(&input.error_message),
        input.duration_ms,
        &input.finished_at,
    )
    .await?;

    let mut attempt = JsonMap::new();
    attempt.insert(
        "turn_id".to_string(),
        JsonValue::Number(input.turn_id.into()),
    );
    attempt.insert(
        "attempt_index".to_string(),
        JsonValue::Number(input.attempt_index.into()),
    );
    attempt.insert(
        "max_retries".to_string(),
        JsonValue::Number(input.max_retries.into()),
    );
    attempt.insert(
        "status".to_string(),
        JsonValue::String("streaming".to_string()),
    );
    attempt.insert(
        "checkpoint_json".to_string(),
        JsonValue::String(input.checkpoint_json),
    );
    attempt.insert(
        "delivery_manifest_json".to_string(),
        JsonValue::String(input.delivery_manifest_json),
    );
    attempt.insert(
        "started_at".to_string(),
        JsonValue::String(input.started_at.clone()),
    );
    attempt.insert(
        "created_at".to_string(),
        JsonValue::String(input.started_at.clone()),
    );
    attempt.insert(
        "updated_at".to_string(),
        JsonValue::String(input.started_at),
    );
    let attempt = insert_one(
        &mut *transaction,
        "session_turn_attempts",
        &attempt,
        ATTEMPT_COLUMNS,
    )
    .await?;

    run(
        &mut *transaction,
        "UPDATE session_turns
         SET status = 'streaming', error_message = NULL, updated_at = datetime('now')
         WHERE id = ?",
        vec![JsonValue::Number(input.turn_id.into())],
    )
    .await?;
    recompute_turn_usage(&mut transaction, input.turn_id, &input.behavior).await?;

    let turn = required_row(
        fetch_one(
            &mut *transaction,
            "SELECT * FROM session_turns WHERE id = ?",
            vec![JsonValue::Number(input.turn_id.into())],
        )
        .await?,
        "Session turn was not found",
    )?;
    transaction
        .commit()
        .await
        .map_err(DatabaseOperationError::from)?;
    Ok(object([
        ("turn", JsonValue::Object(turn)),
        ("attempt", JsonValue::Object(attempt)),
    ]))
}

fn message_fingerprint(
    message: &JsonMap<String, JsonValue>,
    parts: &[JsonMap<String, JsonValue>],
) -> Result<String, DatabaseOperationError> {
    let role = message
        .get("role")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| DatabaseOperationError::unavailable("Message role is missing"))?;
    let semantic_parts = parts
        .iter()
        .filter(|part| {
            !matches!(
                part.get("type").and_then(JsonValue::as_str),
                Some("context_compaction" | "llm_call")
            )
        })
        .map(|part| {
            Ok(JsonValue::Array(vec![
                part.get("type")
                    .cloned()
                    .ok_or_else(|| DatabaseOperationError::unavailable("Part type is missing"))?,
                part.get("content").cloned().ok_or_else(|| {
                    DatabaseOperationError::unavailable("Part content is missing")
                })?,
                part.get("data")
                    .cloned()
                    .ok_or_else(|| DatabaseOperationError::unavailable("Part data is missing"))?,
                part.get("sort_order").cloned().ok_or_else(|| {
                    DatabaseOperationError::unavailable("Part sort order is missing")
                })?,
            ]))
        })
        .collect::<Result<Vec<_>, DatabaseOperationError>>()?;
    let value = JsonValue::Array(vec![
        JsonValue::String(role.to_string()),
        JsonValue::Array(semantic_parts),
    ]);
    let bytes = serde_json::to_vec(&value)
        .map_err(|error| DatabaseOperationError::unavailable(error.to_string()))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn validate_context_summary_json(
    input: &TaskPersistContextSummaryInput,
) -> Result<JsonMap<String, JsonValue>, DatabaseOperationError> {
    let metadata = serde_json::from_str::<JsonMap<String, JsonValue>>(&input.summary_json)
        .map_err(|error| {
            DatabaseOperationError::validation(format!(
                "Context summary metadata must be a JSON object: {error}"
            ))
        })?;
    if metadata.get("version").and_then(JsonValue::as_u64) != Some(2)
        || metadata
            .get("invalidatedAt")
            .is_some_and(|value| !value.is_null())
        || metadata
            .get("id")
            .and_then(JsonValue::as_str)
            .map_or(true, |id| uuid::Uuid::parse_str(id).is_err())
    {
        return Err(DatabaseOperationError::validation(
            "Context summary metadata is invalid",
        ));
    }
    if input.text.trim().is_empty() || input.text.chars().count() > 32_000 {
        return Err(DatabaseOperationError::validation(
            "Context summary text is invalid",
        ));
    }
    let first_kept = metadata
        .get("firstKeptMessageId")
        .and_then(JsonValue::as_i64)
        .filter(|value| *value > 0)
        .ok_or_else(|| {
            DatabaseOperationError::validation("Context summary boundary is invalid")
        })?;
    let system_ids = metadata
        .get("systemMessageIds")
        .and_then(JsonValue::as_array)
        .ok_or_else(|| {
            DatabaseOperationError::validation("Context summary system ids are invalid")
        })?;
    let mut unique = std::collections::HashSet::new();
    for id in system_ids {
        let id = id.as_i64().filter(|id| *id > 0 && *id < first_kept).ok_or_else(|| {
            DatabaseOperationError::validation("Context summary system ids are invalid")
        })?;
        if !unique.insert(id) {
            return Err(DatabaseOperationError::validation(
                "Context summary system ids must be unique",
            ));
        }
    }
    Ok(metadata)
}

async fn update_turn_usage_totals(
    connection: &mut SqliteConnection,
    turn_id: i64,
) -> Result<(), DatabaseOperationError> {
    run(
        connection,
        "UPDATE session_turns
         SET input_tokens = (SELECT COALESCE(SUM(input_tokens), 0) FROM session_turn_attempts WHERE turn_id = ?),
             output_tokens = (SELECT COALESCE(SUM(output_tokens), 0) FROM session_turn_attempts WHERE turn_id = ?),
             cache_read_tokens = (SELECT COALESCE(SUM(cache_read_tokens), 0) FROM session_turn_attempts WHERE turn_id = ?),
             cache_write_tokens = (SELECT COALESCE(SUM(cache_write_tokens), 0) FROM session_turn_attempts WHERE turn_id = ?),
             reasoning_tokens = (SELECT COALESCE(SUM(reasoning_tokens), 0) FROM session_turn_attempts WHERE turn_id = ?),
             total_cost_micros = (SELECT COALESCE(SUM(total_cost_micros), 0) FROM session_turn_attempts WHERE turn_id = ?),
             unpriced_calls = (SELECT COALESCE(SUM(unpriced_calls), 0) FROM session_turn_attempts WHERE turn_id = ?),
             llm_call_count = (SELECT COALESCE(SUM(llm_call_count), 0) FROM session_turn_attempts WHERE turn_id = ?),
             ttft_ms = (
                 SELECT ttft_ms FROM session_turn_attempts
                 WHERE turn_id = ? AND ttft_ms IS NOT NULL
                 ORDER BY attempt_index LIMIT 1
             ),
             updated_at = datetime('now')
         WHERE id = ?",
        (0..10)
            .map(|_| JsonValue::Number(turn_id.into()))
            .collect(),
    )
    .await?;
    Ok(())
}

pub(super) async fn persist_context_summary(
    pool: &SqlitePool,
    input: TaskPersistContextSummaryInput,
) -> Result<JsonValue, DatabaseOperationError> {
    let metadata = validate_context_summary_json(&input)?;
    let first_kept = metadata
        .get("firstKeptMessageId")
        .and_then(JsonValue::as_i64)
        .ok_or_else(|| DatabaseOperationError::validation("Context boundary is missing"))?;
    let system_ids = metadata
        .get("systemMessageIds")
        .and_then(JsonValue::as_array)
        .ok_or_else(|| DatabaseOperationError::validation("Context system ids are missing"))?
        .iter()
        .filter_map(JsonValue::as_i64)
        .collect::<std::collections::HashSet<_>>();
    let previous = input
        .previous_summary_json
        .as_deref()
        .map(serde_json::from_str::<JsonMap<String, JsonValue>>)
        .transpose()
        .map_err(|error| {
            DatabaseOperationError::validation(format!(
                "Previous context summary must be a JSON object: {error}"
            ))
        })?;
    let previous_boundary = previous
        .as_ref()
        .and_then(|summary| summary.get("firstKeptMessageId"))
        .and_then(JsonValue::as_i64);
    let mut transaction = begin_immediate(pool).await?;

    let boundary = fetch_one(
        &mut *transaction,
        "SELECT id, role FROM messages WHERE id = ? AND session_id = ?",
        vec![
            JsonValue::Number(first_kept.into()),
            JsonValue::Number(input.session_id.into()),
        ],
    )
    .await?;
    if boundary.is_none() {
        return Err(DatabaseOperationError::validation(
            "Context summary boundary message was not found",
        ));
    }

    if let Some(previous) = &previous {
        let previous_part = fetch_one(
            &mut *transaction,
            "SELECT message_parts.*
             FROM messages
             INNER JOIN message_parts ON message_parts.message_id = messages.id
             WHERE messages.session_id = ? AND message_parts.type = 'context_compaction'
             ORDER BY message_parts.id DESC
             LIMIT 1",
            vec![JsonValue::Number(input.session_id.into())],
        )
        .await?;
        let mut saved = previous_part
            .as_ref()
            .and_then(|part| {
                let data = part.get("data")?.as_str()?;
                serde_json::from_str::<JsonMap<String, JsonValue>>(data).ok()
            })
            .ok_or_else(|| {
                DatabaseOperationError::validation("Previous context summary was not found")
            })?;
        let text = previous_part
            .as_ref()
            .and_then(|part| part.get("content"))
            .cloned()
            .unwrap_or(JsonValue::Null);
        saved.insert("text".to_string(), text);
        if JsonValue::Object(saved) != JsonValue::Object(previous.clone()) {
            return Err(DatabaseOperationError::validation(
                "Previous context summary changed",
            ));
        }
    }

    let message_rows = fetch_rows(
        &mut *transaction,
        "SELECT * FROM messages WHERE session_id = ? ORDER BY id",
        vec![JsonValue::Number(input.session_id.into())],
    )
    .await?;
    let part_rows = fetch_rows(
        &mut *transaction,
        "SELECT message_parts.*
         FROM message_parts
         INNER JOIN messages ON messages.id = message_parts.message_id
         WHERE messages.session_id = ?
         ORDER BY message_parts.message_id, message_parts.sort_order, message_parts.id",
        vec![JsonValue::Number(input.session_id.into())],
    )
    .await?;
    let mut parts_by_message: HashMap<i64, Vec<JsonMap<String, JsonValue>>> = HashMap::new();
    for part in part_rows {
        let message_id = part.get("message_id").and_then(JsonValue::as_i64).ok_or_else(|| {
            DatabaseOperationError::unavailable("Context message part has no message id")
        })?;
        parts_by_message.entry(message_id).or_default().push(part);
    }
    let mut sources = input
        .source_messages
        .iter()
        .map(|source| (source.id, source.fingerprint.clone()))
        .collect::<HashMap<_, _>>();
    if sources.len() != input.source_messages.len() {
        return Err(DatabaseOperationError::validation(
            "Context source message ids must be unique",
        ));
    }

    let rows = message_rows
        .into_iter()
        .filter(|message| {
            let id = message.get("id").and_then(JsonValue::as_i64).unwrap_or_default();
            let retained = previous_boundary.is_some_and(|boundary| {
                id < boundary && sources.contains_key(&id)
            });
            let in_range = previous_boundary
                .map(|boundary| id >= boundary && id < first_kept)
                .unwrap_or(id < first_kept);
            retained || in_range
        })
        .collect::<Vec<_>>();

    for message in &rows {
        let message_id = message
            .get("id")
            .and_then(JsonValue::as_i64)
            .ok_or_else(|| DatabaseOperationError::unavailable("Context message id is missing"))?;
        if system_ids.contains(&message_id)
            && message.get("role").and_then(JsonValue::as_str) != Some("system")
        {
            return Err(DatabaseOperationError::validation(
                "Context system message changed role",
            ));
        }
        let expected = sources.remove(&message_id);
        let has_visible_text = parts_by_message
            .get(&message_id)
            .is_some_and(|parts| {
                parts.iter().any(|part| {
                    matches!(
                        part.get("type").and_then(JsonValue::as_str),
                        Some("text" | "reasoning")
                    ) && part
                        .get("content")
                        .and_then(JsonValue::as_str)
                        .is_some_and(|content| !content.trim().is_empty())
                })
            });
        if expected.is_none()
            && message.get("role").and_then(JsonValue::as_str) == Some("assistant")
            && !has_visible_text
        {
            continue;
        }
        let actual = message_fingerprint(
            message,
            parts_by_message.get(&message_id).map(Vec::as_slice).unwrap_or(&[]),
        )?;
        if expected.as_deref() != Some(actual.as_str()) {
            return Err(DatabaseOperationError::validation(
                "Context source message changed",
            ));
        }
    }
    if !sources.is_empty() {
        return Err(DatabaseOperationError::validation(
            "Context source messages are incomplete",
        ));
    }

    let message_id = if let Some(message_id) = input.pending_message_id {
        run(
            &mut *transaction,
            "UPDATE messages SET role = 'assistant', updated_at = datetime('now') WHERE id = ?",
            vec![JsonValue::Number(message_id.into())],
        )
        .await?;
        message_id
    } else {
        let mut message = JsonMap::new();
        message.insert(
            "session_id".to_string(),
            JsonValue::Number(input.session_id.into()),
        );
        message.insert(
            "role".to_string(),
            JsonValue::String("assistant".to_string()),
        );
        insert_one(&mut *transaction, "messages", &message, MESSAGE_COLUMNS)
            .await?
            .get("id")
            .and_then(JsonValue::as_i64)
            .ok_or_else(|| DatabaseOperationError::unavailable("Message id is missing"))?
    };
    let maximum = fetch_one(
        &mut *transaction,
        "SELECT COALESCE(MAX(sort_order), -1) AS value
         FROM message_parts WHERE message_id = ?",
        vec![JsonValue::Number(message_id.into())],
    )
    .await?
    .and_then(|row| row.get("value").and_then(JsonValue::as_i64))
    .unwrap_or(-1);
    let created_at = metadata
        .get("createdAt")
        .and_then(JsonValue::as_i64)
        .ok_or_else(|| DatabaseOperationError::validation("Context summary time is missing"))?;
    let mut part = JsonMap::new();
    part.insert(
        "message_id".to_string(),
        JsonValue::Number(message_id.into()),
    );
    part.insert(
        "type".to_string(),
        JsonValue::String("context_compaction".to_string()),
    );
    part.insert("content".to_string(), JsonValue::String(input.text.clone()));
    part.insert(
        "data".to_string(),
        JsonValue::String(input.summary_json.clone()),
    );
    part.insert(
        "started_at".to_string(),
        JsonValue::Number(created_at.into()),
    );
    part.insert(
        "ended_at".to_string(),
        JsonValue::Number(created_at.into()),
    );
    part.insert(
        "sort_order".to_string(),
        JsonValue::Number((maximum + 1).into()),
    );
    let part = insert_one(
        &mut *transaction,
        "message_parts",
        &part,
        MESSAGE_PART_COLUMNS,
    )
    .await?;
    run(
        &mut *transaction,
        "UPDATE session_turns
         SET response_message_id = ?, updated_at = datetime('now')
         WHERE id = ?",
        vec![
            JsonValue::Number(message_id.into()),
            JsonValue::Number(input.turn_id.into()),
        ],
    )
    .await?;
    if let Some(usage) = &input.usage {
        update_attempt_usage(&mut transaction, input.attempt_id, usage).await?;
        update_turn_usage_totals(&mut transaction, input.turn_id).await?;
    }

    transaction
        .commit()
        .await
        .map_err(DatabaseOperationError::from)?;
    Ok(object([
        ("messageId", JsonValue::Number(message_id.into())),
        (
            "partId",
            part.get("id").cloned().unwrap_or(JsonValue::Null),
        ),
    ]))
}
