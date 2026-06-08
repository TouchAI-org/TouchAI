DELETE FROM main.memory_items;

INSERT INTO main.memory_items (
    id, title, applicability, content, enabled, source_session_id, source_message_id,
    created_at, updated_at, last_used_at
)
SELECT
    source_memory.id,
    source_memory.title,
    source_memory.applicability,
    source_memory.content,
    source_memory.enabled,
    source_session_map.target_session_id,
    source_message_map.target_message_id,
    source_memory.created_at,
    source_memory.updated_at,
    source_memory.last_used_at
FROM temp_imported_memory_items AS source_memory
LEFT JOIN temp_session_map AS source_session_map
    ON source_session_map.source_session_id = source_memory.source_session_id
LEFT JOIN temp_message_map AS source_message_map
    ON source_message_map.source_message_id = source_memory.source_message_id;

DELETE FROM main.sqlite_sequence
WHERE name IN (
    'providers',
    'models',
    'sessions',
    'messages',
    'attachments',
    'message_attachments',
    'session_turns',
    'session_turn_attempts',
    'memory_items',
    'settings',
    'statistics',
    'llm_metadata'
);

INSERT INTO main.sqlite_sequence (name, seq) SELECT 'providers', COALESCE(MAX(id), 0) FROM main.providers;
INSERT INTO main.sqlite_sequence (name, seq) SELECT 'models', COALESCE(MAX(id), 0) FROM main.models;
INSERT INTO main.sqlite_sequence (name, seq) SELECT 'sessions', COALESCE(MAX(id), 0) FROM main.sessions;
INSERT INTO main.sqlite_sequence (name, seq) SELECT 'messages', COALESCE(MAX(id), 0) FROM main.messages;
INSERT INTO main.sqlite_sequence (name, seq) SELECT 'attachments', COALESCE(MAX(id), 0) FROM main.attachments;
INSERT INTO main.sqlite_sequence (name, seq) SELECT 'message_attachments', COALESCE(MAX(id), 0) FROM main.message_attachments;
INSERT INTO main.sqlite_sequence (name, seq) SELECT 'session_turns', COALESCE(MAX(id), 0) FROM main.session_turns;
INSERT INTO main.sqlite_sequence (name, seq) SELECT 'session_turn_attempts', COALESCE(MAX(id), 0) FROM main.session_turn_attempts;
INSERT INTO main.sqlite_sequence (name, seq) SELECT 'memory_items', COALESCE(MAX(id), 0) FROM main.memory_items;
INSERT INTO main.sqlite_sequence (name, seq) SELECT 'settings', COALESCE(MAX(id), 0) FROM main.settings;
INSERT INTO main.sqlite_sequence (name, seq) SELECT 'statistics', COALESCE(MAX(id), 0) FROM main.statistics;
INSERT INTO main.sqlite_sequence (name, seq) SELECT 'llm_metadata', COALESCE(MAX(id), 0) FROM main.llm_metadata;
