INSERT INTO settings SELECT * FROM imported.settings;
INSERT INTO statistics SELECT * FROM imported.statistics
WHERE key IN ('model_metadata_source_etag', 'model_metadata_last_checked_at', 'model_metadata_last_updated_at');
INSERT INTO providers SELECT * FROM imported.providers;
INSERT INTO models SELECT * FROM imported.models;
INSERT INTO llm_metadata SELECT * FROM imported.llm_metadata;
INSERT INTO llm_metadata_aliases SELECT * FROM imported.llm_metadata_aliases;
INSERT INTO mcp_servers SELECT * FROM imported.mcp_servers;
INSERT INTO mcp_tools SELECT * FROM imported.mcp_tools;
INSERT INTO built_in_tools SELECT * FROM imported.built_in_tools;
