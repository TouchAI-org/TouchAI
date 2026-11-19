-- Keep usage aggregates, not the removed conversations' content snapshots.
UPDATE session_turns
SET prompt_snapshot_json = '{}', error_message = NULL,
    session_id = NULL, prompt_message_id = NULL, response_message_id = NULL;
UPDATE session_turn_attempts
SET checkpoint_json = '{}', delivery_manifest_json = '{}', error_message = NULL;
DELETE FROM messages;
UPDATE sessions
SET last_message_preview = NULL, last_message_at = NULL, message_count = 0,
    status_badge_dismissed_turn_id = NULL;
