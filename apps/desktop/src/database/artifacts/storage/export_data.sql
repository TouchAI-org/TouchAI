INSERT INTO models (id, provider_id, name, model_id)
SELECT id, provider_id, name, model_id FROM imported.models
WHERE id IN (
    SELECT model_id FROM imported.session_turns
    UNION SELECT json_extract(checkpoint_json, '$.activeModelId') FROM imported.session_turn_attempts
    UNION SELECT json_extract(data, '$.modelId') FROM imported.message_parts WHERE type = 'context_compaction'
);
INSERT INTO providers (id, name, driver, api_endpoint, logo, enabled)
SELECT id, name, driver, '', '', 0 FROM imported.providers
WHERE id IN (
    SELECT provider_id FROM models
    UNION SELECT provider_id FROM imported.sessions
    UNION SELECT json_extract(data, '$.providerId') FROM imported.message_parts WHERE type = 'context_compaction'
);
INSERT INTO mcp_servers (id, name, transport_type, enabled)
SELECT id, name, transport_type, 0 FROM imported.mcp_servers
WHERE id IN (SELECT server_id FROM imported.message_parts WHERE tool_kind = 'mcp');
INSERT INTO sessions SELECT * FROM imported.sessions;
INSERT INTO messages SELECT * FROM imported.messages;
INSERT INTO attachments SELECT * FROM imported.attachments;
INSERT INTO message_parts (id, message_id, type, content, data, started_at, ended_at, sort_order, created_at, updated_at)
SELECT id, message_id, type, content, data, started_at, ended_at, sort_order, created_at, updated_at FROM imported.message_parts;
INSERT INTO session_turns SELECT * FROM imported.session_turns;
INSERT INTO session_turn_attempts SELECT * FROM imported.session_turn_attempts;
INSERT INTO usage_daily_rollups SELECT * FROM imported.usage_daily_rollups;
INSERT INTO statistics SELECT * FROM imported.statistics WHERE key = 'usage_rollup_baseline';
INSERT INTO quick_search_click_stats SELECT * FROM imported.quick_search_click_stats;
