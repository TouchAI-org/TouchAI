UPDATE main.models
SET is_default = 0;

DELETE FROM main.settings;
DELETE FROM main.statistics;
DELETE FROM main.llm_metadata;

INSERT INTO main.providers (
    id, name, driver, api_endpoint, api_key, config_json, logo,
    enabled, is_builtin, created_at, updated_at
)
SELECT
    id, name, driver, api_endpoint, api_key, config_json, logo,
    enabled, is_builtin, created_at, updated_at
FROM imported.providers
WHERE true
ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    driver = excluded.driver,
    api_endpoint = excluded.api_endpoint,
    api_key = excluded.api_key,
    config_json = excluded.config_json,
    logo = excluded.logo,
    enabled = excluded.enabled,
    is_builtin = excluded.is_builtin,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at;

INSERT INTO main.models (
    id, provider_id, name, model_id, is_default, last_used_at,
    attachment, modalities, open_weights, reasoning, release_date,
    temperature, tool_call, knowledge, context_limit, output_limit,
    is_custom_metadata, created_at, updated_at
)
SELECT
    id, provider_id, name, model_id, is_default, last_used_at,
    attachment, modalities, open_weights, reasoning, release_date,
    temperature, tool_call, knowledge, context_limit, output_limit,
    is_custom_metadata, created_at, updated_at
FROM imported.models
WHERE true
ON CONFLICT(id) DO UPDATE SET
    provider_id = excluded.provider_id,
    name = excluded.name,
    model_id = excluded.model_id,
    is_default = excluded.is_default,
    last_used_at = excluded.last_used_at,
    attachment = excluded.attachment,
    modalities = excluded.modalities,
    open_weights = excluded.open_weights,
    reasoning = excluded.reasoning,
    release_date = excluded.release_date,
    temperature = excluded.temperature,
    tool_call = excluded.tool_call,
    knowledge = excluded.knowledge,
    context_limit = excluded.context_limit,
    output_limit = excluded.output_limit,
    is_custom_metadata = excluded.is_custom_metadata,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at;

INSERT INTO main.settings (id, key, value, created_at, updated_at)
SELECT id, key, value, created_at, updated_at
FROM imported.settings;

INSERT INTO main.statistics (id, key, value, created_at, updated_at)
SELECT id, key, value, created_at, updated_at
FROM imported.statistics;

INSERT INTO main.llm_metadata (
    id, model_id, name, attachment, modalities, open_weights, reasoning,
    release_date, temperature, tool_call, knowledge, [limit], created_at, updated_at
)
SELECT
    id, model_id, name, attachment, modalities, open_weights, reasoning,
    release_date, temperature, tool_call, knowledge, [limit], created_at, updated_at
FROM imported.llm_metadata;
