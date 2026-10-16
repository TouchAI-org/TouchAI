UPDATE main.models
SET is_default = 0;

DELETE FROM main.settings;
DELETE FROM main.statistics;
DELETE FROM main.llm_metadata_aliases;
DELETE FROM main.llm_metadata;

-- Provider and model ids are local rowids, so full import matches them by
-- stable identity instead of copying source ids into the target database.
INSERT INTO main.providers (
    name, driver, api_endpoint, api_key, config_json, logo,
    enabled, is_builtin, created_at, updated_at
)
SELECT
    source.name, source.driver, source.api_endpoint, source.api_key,
    source.config_json, source.logo, source.enabled, source.is_builtin,
    source.created_at, source.updated_at
FROM imported.providers AS source
WHERE NOT EXISTS (
    SELECT 1
    FROM main.providers AS target
    WHERE target.name = source.name
      AND target.driver = source.driver
);

UPDATE main.providers
SET (api_endpoint, api_key, config_json, logo, enabled, is_builtin, updated_at) = (
    SELECT
        source.api_endpoint, source.api_key, source.config_json, source.logo,
        source.enabled, source.is_builtin, source.updated_at
    FROM imported.providers AS source
    WHERE source.name = main.providers.name AND source.driver = main.providers.driver
)
WHERE EXISTS (
    SELECT 1
    FROM imported.providers AS source
    WHERE source.name = main.providers.name AND source.driver = main.providers.driver
);

INSERT INTO main.models (
    provider_id, name, model_id, is_default, last_used_at,
    attachment, modalities, open_weights, reasoning, release_date,
    temperature, tool_call, knowledge, context_limit, output_limit,
    is_custom_metadata, created_at, updated_at
)
SELECT
    target_providers.id,
    source.name,
    source.model_id,
    source.is_default,
    source.last_used_at,
    source.attachment,
    source.modalities,
    source.open_weights,
    source.reasoning,
    source.release_date,
    source.temperature,
    source.tool_call,
    source.knowledge,
    source.context_limit,
    source.output_limit,
    source.is_custom_metadata,
    source.created_at,
    source.updated_at
FROM imported.models AS source
INNER JOIN imported.providers AS source_providers
    ON source_providers.id = source.provider_id
INNER JOIN main.providers AS target_providers
    ON target_providers.name = source_providers.name
   AND target_providers.driver = source_providers.driver
WHERE NOT EXISTS (
    SELECT 1
    FROM main.models AS target
    WHERE target.provider_id = target_providers.id
      AND target.model_id = source.model_id
);

UPDATE main.models
SET (name, is_default, last_used_at, attachment, modalities, open_weights, reasoning,
     release_date, temperature, tool_call, knowledge, context_limit, output_limit,
     is_custom_metadata, updated_at) = (
    SELECT
        source.name, source.is_default, source.last_used_at, source.attachment,
        source.modalities, source.open_weights, source.reasoning, source.release_date,
        source.temperature, source.tool_call, source.knowledge, source.context_limit,
        source.output_limit, source.is_custom_metadata, source.updated_at
    FROM imported.models AS source
    INNER JOIN imported.providers AS source_providers
        ON source_providers.id = source.provider_id
    INNER JOIN main.providers AS target_providers
        ON target_providers.name = source_providers.name
       AND target_providers.driver = source_providers.driver
    WHERE target_providers.id = main.models.provider_id
      AND source.model_id = main.models.model_id
)
WHERE EXISTS (
    SELECT 1
    FROM imported.models AS source
    INNER JOIN imported.providers AS source_providers
        ON source_providers.id = source.provider_id
    INNER JOIN main.providers AS target_providers
        ON target_providers.name = source_providers.name
       AND target_providers.driver = source_providers.driver
    WHERE target_providers.id = main.models.provider_id
      AND source.model_id = main.models.model_id
);

INSERT INTO main.settings (key, value, created_at, updated_at)
SELECT key, value, created_at, updated_at
FROM imported.settings;

INSERT INTO main.statistics (key, value, created_at, updated_at)
SELECT key, value, created_at, updated_at
FROM imported.statistics;

INSERT INTO main.llm_metadata (
    model_id, name, attachment, modalities, open_weights, reasoning, reasoning_options,
    release_date, temperature, tool_call, knowledge, [limit], created_at, updated_at
)
SELECT
    model_id, name, attachment, modalities, open_weights, reasoning, reasoning_options,
    release_date, temperature, tool_call, knowledge, [limit], created_at, updated_at
FROM imported.llm_metadata;

INSERT INTO main.llm_metadata_aliases (alias, model_id)
SELECT
    alias, model_id
FROM imported.llm_metadata_aliases;

INSERT INTO main.mcp_servers (
    name, transport_type, command, args, env, cwd, url, headers,
    enabled, tool_timeout, version, last_error, last_connected_at,
    created_at, updated_at
)
SELECT
    name, transport_type, command, args, env, cwd, url, headers,
    enabled, tool_timeout, version, last_error, last_connected_at,
    created_at, updated_at
FROM imported.mcp_servers
WHERE true
ON CONFLICT(name) DO UPDATE SET
    transport_type = excluded.transport_type,
    command = excluded.command,
    args = excluded.args,
    env = excluded.env,
    cwd = excluded.cwd,
    url = excluded.url,
    headers = excluded.headers,
    enabled = excluded.enabled,
    tool_timeout = excluded.tool_timeout,
    version = excluded.version,
    last_error = excluded.last_error,
    last_connected_at = excluded.last_connected_at,
    updated_at = excluded.updated_at;

INSERT INTO main.mcp_tools (
    server_id, name, description, input_schema, enabled, created_at, updated_at
)
SELECT
    target_servers.id,
    source_tools.name,
    source_tools.description,
    source_tools.input_schema,
    source_tools.enabled,
    source_tools.created_at,
    source_tools.updated_at
FROM imported.mcp_tools AS source_tools
INNER JOIN imported.mcp_servers AS source_servers
    ON source_servers.id = source_tools.server_id
INNER JOIN main.mcp_servers AS target_servers
    ON target_servers.name = source_servers.name
WHERE NOT EXISTS (
    SELECT 1
    FROM main.mcp_tools AS target_tools
    WHERE target_tools.server_id = target_servers.id
      AND target_tools.name = source_tools.name
);

UPDATE main.mcp_tools
SET (description, input_schema, enabled, updated_at) = (
    SELECT
        source_tools.description, source_tools.input_schema, source_tools.enabled,
        source_tools.updated_at
    FROM imported.mcp_tools AS source_tools
    INNER JOIN imported.mcp_servers AS source_servers
        ON source_servers.id = source_tools.server_id
    INNER JOIN main.mcp_servers AS target_servers
        ON target_servers.name = source_servers.name
    WHERE target_servers.id = main.mcp_tools.server_id
      AND source_tools.name = main.mcp_tools.name
)
WHERE EXISTS (
    SELECT 1
    FROM imported.mcp_tools AS source_tools
    INNER JOIN imported.mcp_servers AS source_servers
        ON source_servers.id = source_tools.server_id
    INNER JOIN main.mcp_servers AS target_servers
        ON target_servers.name = source_servers.name
    WHERE target_servers.id = main.mcp_tools.server_id
      AND source_tools.name = main.mcp_tools.name
);

INSERT INTO main.built_in_tools (
    tool_id, display_name, description, enabled, risk_level, config_json,
    last_used_at, created_at, updated_at
)
SELECT
    tools.tool_id, tools.display_name, tools.description, tools.enabled, tools.risk_level,
    CASE
        WHEN tools.tool_id = 'upgrade_model'
         AND json_type(tools.config_json, '$.chain') = 'array'
        THEN json_set(tools.config_json, '$.chain', json((
            SELECT json_group_array(json(mapped.entry) ORDER BY mapped.chain_key)
            FROM (
                -- Removed providers cannot be executed; never reuse their source rowids.
                SELECT json_set(chain.value, '$.providerId', target.id) AS entry,
                       chain.key AS chain_key
                FROM json_each(tools.config_json, '$.chain') AS chain
                INNER JOIN imported.providers AS source
                    ON source.id = json_extract(chain.value, '$.providerId')
                INNER JOIN main.providers AS target
                    ON target.name = source.name AND target.driver = source.driver
            ) AS mapped
        )))
        ELSE tools.config_json
    END,
    tools.last_used_at, tools.created_at, tools.updated_at
FROM imported.built_in_tools AS tools
WHERE true
ON CONFLICT(tool_id) DO UPDATE SET
    display_name = excluded.display_name,
    description = excluded.description,
    enabled = excluded.enabled,
    risk_level = excluded.risk_level,
    config_json = excluded.config_json,
    last_used_at = excluded.last_used_at,
    updated_at = excluded.updated_at;

INSERT INTO main.quick_search_click_stats (
    query_norm, path_norm, click_count, created_at, updated_at
)
SELECT query_norm, path_norm, click_count, created_at, updated_at
FROM imported.quick_search_click_stats
WHERE true
ON CONFLICT(query_norm, path_norm) DO UPDATE SET
    click_count = excluded.click_count,
    updated_at = excluded.updated_at;
