-- A NULL session relation is not a reason to retain an old prompt snapshot.
UPDATE session_turns
SET prompt_snapshot_json = '{}', error_message = NULL,
    session_id = NULL, prompt_message_id = NULL, response_message_id = NULL;
UPDATE session_turn_attempts
SET checkpoint_json = '{}', delivery_manifest_json = '{}', error_message = NULL;
DELETE FROM sessions;
