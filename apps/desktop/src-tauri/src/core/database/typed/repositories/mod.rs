// Copyright (c) 2026. 千诚. Licensed under GPL v3.

mod attachments;
mod builtins;
mod llm_metadata;
mod mcp;
mod models;
mod providers;
mod sessions;
mod settings;
mod tasks;
mod tool_parts;

use serde_json::Value as JsonValue;
use sqlx::SqlitePool;

use super::operation::{DatabaseOperation, DatabaseOperationError};

pub(super) async fn execute(
    pool: &SqlitePool,
    operation: DatabaseOperation,
) -> Result<JsonValue, DatabaseOperationError> {
    match operation {
        DatabaseOperation::SettingFind { key } => settings::find_setting(pool, key).await,
        DatabaseOperation::SettingGet { key } => settings::get_setting(pool, key).await,
        DatabaseOperation::SettingGetMany { keys } => settings::get_settings(pool, keys).await,
        DatabaseOperation::SettingSet { key, value } => {
            settings::set_setting(pool, key, value).await
        }
        DatabaseOperation::StatisticGet { key } => settings::get_statistic(pool, key).await,
        DatabaseOperation::StatisticSet { key, value } => {
            settings::set_statistic(pool, key, value).await
        }
        DatabaseOperation::MetaGet { key } => settings::get_meta(pool, key).await,
        DatabaseOperation::MetaSet { key, value } => settings::set_meta(pool, key, value).await,
        DatabaseOperation::MetaDelete { key } => settings::delete_meta(pool, key).await,
        DatabaseOperation::QuickSearchFind { query_norm, limit } => {
            settings::find_quick_search(pool, query_norm, limit).await
        }
        DatabaseOperation::QuickSearchFindRecent { query_norm, limit } => {
            settings::find_recent_quick_search(pool, query_norm, limit).await
        }
        DatabaseOperation::QuickSearchUpsert {
            query_norm,
            path_norm,
            max_click_count,
        } => settings::upsert_quick_search(pool, query_norm, path_norm, max_click_count).await,
        DatabaseOperation::ProviderList => providers::list(pool).await,
        DatabaseOperation::ProviderFind { id } => providers::find(pool, id).await,
        DatabaseOperation::ProviderCreate { data } => providers::create(pool, data).await,
        DatabaseOperation::ProviderUpdate { id, data } => providers::update(pool, id, data).await,
        DatabaseOperation::ProviderDelete { id } => providers::delete(pool, id).await,
        DatabaseOperation::SessionCreate { data } => sessions::create(pool, data).await,
        DatabaseOperation::SessionFindById { id } => sessions::find_by_id(pool, id).await,
        DatabaseOperation::SessionList { query, limit } => sessions::list(pool, query, limit).await,
        DatabaseOperation::SessionUpdate { id, data } => sessions::update(pool, id, data).await,
        DatabaseOperation::SessionDismissTerminalStatus { id } => {
            sessions::dismiss_terminal_status(pool, id).await
        }
        DatabaseOperation::SessionRefreshMetadata { id } => {
            sessions::refresh_metadata(pool, id).await
        }
        DatabaseOperation::SessionCount => sessions::count_sessions(pool).await,
        DatabaseOperation::SessionDeleteAll => sessions::delete_all(pool).await,
        DatabaseOperation::ToolPartCreate { tool_kind, data } => {
            tool_parts::create(pool, tool_kind, data).await
        }
        DatabaseOperation::ToolPartList {
            tool_kind,
            filter,
            limit,
            offset,
        } => tool_parts::list(pool, tool_kind, filter, limit, offset).await,
        DatabaseOperation::ToolPartSummaries {
            tool_kind,
            filter,
            limit,
            offset,
        } => tool_parts::summaries(pool, tool_kind, filter, limit, offset).await,
        DatabaseOperation::ToolPartUpdate {
            tool_kind,
            filter,
            data,
        } => tool_parts::update(pool, tool_kind, filter, data).await,
        DatabaseOperation::ModelListWithProvider { provider_id } => {
            models::list_with_provider(pool, provider_id).await
        }
        DatabaseOperation::ModelFindDefaultWithProvider => {
            models::find_default_with_provider(pool).await
        }
        DatabaseOperation::ModelFindByProviderAndModelId {
            provider_id,
            model_id,
        } => models::find_by_provider_and_model_id(pool, provider_id, model_id).await,
        DatabaseOperation::ModelFindDefault => models::find_default(pool).await,
        DatabaseOperation::ModelCreate { data } => models::create(pool, data).await,
        DatabaseOperation::ModelUpdate { id, data } => models::update(pool, id, data).await,
        DatabaseOperation::ModelDelete { id } => models::delete(pool, id).await,
        DatabaseOperation::ModelSetDefault { model_id } => {
            models::set_default(pool, model_id).await
        }
        DatabaseOperation::ModelRecordUpstreamMetadata {
            provider_id,
            entries,
        } => models::record_upstream_metadata(pool, provider_id, entries).await,
        DatabaseOperation::ModelPersistCatalog {
            provider_id,
            models,
            entries,
        } => models::persist_catalog(pool, provider_id, models, entries).await,
        DatabaseOperation::ModelSyncMetadata => models::sync_metadata(pool).await,
        DatabaseOperation::LlmMetadataFind { model_id } => llm_metadata::find(pool, model_id).await,
        DatabaseOperation::LlmMetadataInsert { data } => llm_metadata::insert(pool, data).await,
        DatabaseOperation::LlmMetadataClear => llm_metadata::clear(pool).await,
        DatabaseOperation::LlmMetadataIsEmpty => llm_metadata::is_empty(pool).await,
        DatabaseOperation::LlmMetadataAliasIsEmpty => llm_metadata::alias_is_empty(pool).await,
        DatabaseOperation::LlmMetadataFindPricing { model_id } => {
            llm_metadata::find_pricing(pool, model_id).await
        }
        DatabaseOperation::LlmMetadataCountPriced => llm_metadata::count_priced(pool).await,
        DatabaseOperation::LlmMetadataReplace {
            metadata,
            aliases,
            mark_updated_at,
            source_etag,
        } => llm_metadata::replace(pool, metadata, aliases, mark_updated_at, source_etag).await,
        DatabaseOperation::LlmMetadataMarkChecked { checked_at, etag } => {
            llm_metadata::mark_checked(pool, checked_at, etag).await
        }
        DatabaseOperation::McpServerList { enabled_only } => {
            mcp::list_servers(pool, enabled_only).await
        }
        DatabaseOperation::McpServerFindById { id } => mcp::find_server(pool, id).await,
        DatabaseOperation::McpServerFindByName { name } => {
            mcp::find_server_by_name(pool, name).await
        }
        DatabaseOperation::McpServerCreate { data } => mcp::create_server(pool, data).await,
        DatabaseOperation::McpServerUpdate { id, data } => mcp::update_server(pool, id, data).await,
        DatabaseOperation::McpServerDelete { id } => mcp::delete_server(pool, id).await,
        DatabaseOperation::McpServerCount => mcp::count_servers(pool).await,
        DatabaseOperation::McpToolList {
            server_id,
            enabled_only,
        } => mcp::list_tools(pool, server_id, enabled_only).await,
        DatabaseOperation::McpToolFindById { id } => mcp::find_tool(pool, id).await,
        DatabaseOperation::McpToolFindByServerAndName { server_id, name } => {
            mcp::find_tool_by_server_and_name(pool, server_id, name).await
        }
        DatabaseOperation::McpToolCreate { data } => mcp::create_tool(pool, data).await,
        DatabaseOperation::McpToolUpdate { id, data } => mcp::update_tool(pool, id, data).await,
        DatabaseOperation::McpToolDelete { id } => mcp::delete_tool(pool, id).await,
        DatabaseOperation::McpToolDeleteByServer { server_id } => {
            mcp::delete_tools_by_server(pool, server_id).await
        }
        DatabaseOperation::McpToolCount { server_id } => mcp::count_tools(pool, server_id).await,
        DatabaseOperation::McpToolSync { server_id, tools } => {
            mcp::sync_tools(pool, server_id, tools).await
        }
        DatabaseOperation::BuiltInToolList { enabled_only } => {
            builtins::list(pool, enabled_only).await
        }
        DatabaseOperation::BuiltInToolFindById { id } => builtins::find_by_id(pool, id).await,
        DatabaseOperation::BuiltInToolFindByToolId { tool_id } => {
            builtins::find_by_tool_id(pool, tool_id).await
        }
        DatabaseOperation::BuiltInToolCreate { data } => builtins::create(pool, data).await,
        DatabaseOperation::BuiltInToolUpdate { id, data } => builtins::update(pool, id, data).await,
        DatabaseOperation::BuiltInToolUpdateMany { ids, data } => {
            builtins::update_many(pool, ids, data).await
        }
        DatabaseOperation::BuiltInToolTouch {
            tool_id,
            last_used_at,
        } => builtins::touch(pool, tool_id, last_used_at).await,
        DatabaseOperation::BuiltInToolCountEnabled => builtins::count_enabled(pool).await,
        DatabaseOperation::AttachmentEnsure { input } => {
            attachments::ensure_operation(pool, input).await
        }
        DatabaseOperation::TaskRecordStart { input } => tasks::record_start(pool, input).await,
        DatabaseOperation::TaskPersistOutputMessage { input } => {
            tasks::persist_output_message(pool, input).await
        }
        DatabaseOperation::TaskPersistToolResult { input } => {
            tasks::persist_tool_result(pool, input).await
        }
        DatabaseOperation::TaskUpdateAttempt { input } => tasks::update_attempt(pool, input).await,
        DatabaseOperation::TaskFinish { input } => tasks::finish(pool, input).await,
        DatabaseOperation::TaskBeginNextAttempt { input } => {
            tasks::begin_next_attempt(pool, input).await
        }
    }
}
