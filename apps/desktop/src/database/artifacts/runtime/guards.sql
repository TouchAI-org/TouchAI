CREATE UNIQUE INDEX IF NOT EXISTS models_single_default_idx
ON models(is_default)
WHERE is_default = 1;

CREATE TRIGGER IF NOT EXISTS trg_providers_prevent_builtin_delete
BEFORE DELETE ON providers
FOR EACH ROW
WHEN OLD.is_builtin = 1
BEGIN
    SELECT RAISE(ABORT, '无法删除内置服务商');
END;

CREATE TRIGGER IF NOT EXISTS trg_providers_prevent_disable_default
BEFORE UPDATE OF enabled ON providers
FOR EACH ROW
WHEN NEW.enabled = 0
 AND EXISTS (
    SELECT 1
    FROM models
    WHERE provider_id = OLD.id
      AND is_default = 1
 )
BEGIN
    SELECT RAISE(ABORT, '无法禁用包含默认模型的服务商');
END;

CREATE TRIGGER IF NOT EXISTS trg_providers_prevent_delete_default
BEFORE DELETE ON providers
FOR EACH ROW
WHEN EXISTS (
    SELECT 1
    FROM models
    WHERE provider_id = OLD.id
      AND is_default = 1
)
BEGIN
    SELECT RAISE(ABORT, '无法删除包含默认模型的服务商');
END;

CREATE TRIGGER IF NOT EXISTS trg_sessions_updated_at
AFTER UPDATE ON sessions
FOR EACH ROW
BEGIN
    UPDATE sessions
    SET updated_at = datetime('now')
    WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_messages_updated_at
AFTER UPDATE ON messages
FOR EACH ROW
BEGIN
    UPDATE messages
    SET updated_at = datetime('now')
    WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_settings_updated_at
AFTER UPDATE ON settings
FOR EACH ROW
BEGIN
    UPDATE settings
    SET updated_at = datetime('now')
    WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_statistics_updated_at
AFTER UPDATE ON statistics
FOR EACH ROW
BEGIN
    UPDATE statistics
    SET updated_at = datetime('now')
    WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_touchai_meta_updated_at
AFTER UPDATE ON touchai_meta
FOR EACH ROW
BEGIN
    UPDATE touchai_meta
    SET updated_at = datetime('now')
    WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_providers_updated_at
AFTER UPDATE ON providers
FOR EACH ROW
BEGIN
    UPDATE providers
    SET updated_at = datetime('now')
    WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_models_updated_at
AFTER UPDATE ON models
FOR EACH ROW
BEGIN
    UPDATE models
    SET updated_at = datetime('now')
    WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_session_turns_updated_at
AFTER UPDATE ON session_turns
FOR EACH ROW
BEGIN
    UPDATE session_turns
    SET updated_at = datetime('now')
    WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_session_turn_attempts_updated_at
AFTER UPDATE ON session_turn_attempts
FOR EACH ROW
BEGIN
    UPDATE session_turn_attempts
    SET updated_at = datetime('now')
    WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_llm_metadata_updated_at
AFTER UPDATE ON llm_metadata
FOR EACH ROW
BEGIN
    UPDATE llm_metadata
    SET updated_at = datetime('now')
    WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_mcp_servers_updated_at
AFTER UPDATE ON mcp_servers
FOR EACH ROW
BEGIN
    UPDATE mcp_servers
    SET updated_at = datetime('now')
    WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_mcp_tools_updated_at
AFTER UPDATE ON mcp_tools
FOR EACH ROW
BEGIN
    UPDATE mcp_tools
    SET updated_at = datetime('now')
    WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_built_in_tools_updated_at
AFTER UPDATE ON built_in_tools
FOR EACH ROW
BEGIN
    UPDATE built_in_tools
    SET updated_at = datetime('now')
    WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_quick_search_click_stats_updated_at
AFTER UPDATE ON quick_search_click_stats
FOR EACH ROW
BEGIN
    UPDATE quick_search_click_stats
    SET updated_at = datetime('now')
    WHERE id = NEW.id;
END;
