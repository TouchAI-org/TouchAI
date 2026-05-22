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
INSERT INTO main.sqlite_sequence (name, seq) SELECT 'settings', COALESCE(MAX(id), 0) FROM main.settings;
INSERT INTO main.sqlite_sequence (name, seq) SELECT 'statistics', COALESCE(MAX(id), 0) FROM main.statistics;
INSERT INTO main.sqlite_sequence (name, seq) SELECT 'llm_metadata', COALESCE(MAX(id), 0) FROM main.llm_metadata;
