// Copyright (c) 2026. 千诚. Licensed under GPL v3.

use super::OperationGroup;
use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};

/// A named database operation. The tagged payload is deliberately not a SQL
/// envelope; each variant maps to one repository method.
#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub(crate) enum DatabaseOperation {
    SettingFind {
        key: String,
    },
    SettingGet {
        key: String,
    },
    SettingSet {
        key: String,
        value: String,
    },
    StatisticGet {
        key: String,
    },
    StatisticSet {
        key: String,
        value: String,
    },
    MetaGet {
        key: String,
    },
    MetaSet {
        key: String,
        value: String,
    },
    MetaDelete {
        key: String,
    },
    QuickSearchFind {
        query_norm: String,
        limit: u32,
    },
    QuickSearchUpsert {
        query_norm: String,
        path_norm: String,
        max_click_count: u32,
    },
    SessionCreate {
        data: JsonMap<String, JsonValue>,
    },
    SessionFindById {
        id: i64,
    },
    SessionList {
        query: Option<String>,
        limit: Option<u32>,
    },
    SessionUpdate {
        id: i64,
        data: JsonMap<String, JsonValue>,
    },
    SessionDismissTerminalStatus {
        id: i64,
    },
    SessionRefreshMetadata {
        id: i64,
    },
    SessionCount,
    SessionDeleteAll,
    ProviderList,
    ProviderFind {
        id: i64,
    },
    ProviderCreate {
        data: JsonMap<String, JsonValue>,
    },
    ProviderUpdate {
        id: i64,
        data: JsonMap<String, JsonValue>,
    },
    ProviderDelete {
        id: i64,
    },
    ModelListWithProvider {
        provider_id: Option<i64>,
    },
    ModelFindDefaultWithProvider,
    ModelFindByProviderAndModelId {
        provider_id: i64,
        model_id: String,
    },
    ModelFindDefault,
    ModelCreate {
        data: JsonMap<String, JsonValue>,
    },
    ModelUpdate {
        id: i64,
        data: JsonMap<String, JsonValue>,
    },
    ModelDelete {
        id: i64,
    },
    ModelSetDefault {
        model_id: i64,
    },
    ModelRecordUpstreamMetadata {
        provider_id: i64,
        entries: Vec<UpstreamMetadataEntry>,
    },
    ModelPersistCatalog {
        provider_id: i64,
        models: Vec<CatalogModel>,
        entries: Vec<UpstreamMetadataEntry>,
    },
    ModelSyncMetadata,
    LlmMetadataFind {
        model_id: String,
    },
    LlmMetadataInsert {
        data: Vec<JsonMap<String, JsonValue>>,
    },
    LlmMetadataClear,
    LlmMetadataIsEmpty,
    LlmMetadataAliasIsEmpty,
    LlmMetadataFindPricing {
        model_id: String,
    },
    LlmMetadataCountPriced,
    LlmMetadataReplace {
        metadata: Vec<JsonMap<String, JsonValue>>,
        aliases: Vec<JsonMap<String, JsonValue>>,
        mark_updated_at: bool,
        source_etag: Option<String>,
    },
    LlmMetadataMarkChecked {
        checked_at: String,
        etag: Option<String>,
    },
    McpServerList {
        enabled_only: bool,
    },
    McpServerFindById {
        id: i64,
    },
    McpServerFindByName {
        name: String,
    },
    McpServerCreate {
        data: JsonMap<String, JsonValue>,
    },
    McpServerUpdate {
        id: i64,
        data: JsonMap<String, JsonValue>,
    },
    McpServerDelete {
        id: i64,
    },
    McpServerCount,
    McpToolList {
        server_id: Option<i64>,
        enabled_only: bool,
    },
    McpToolFindById {
        id: i64,
    },
    McpToolFindByServerAndName {
        server_id: i64,
        name: String,
    },
    McpToolCreate {
        data: JsonMap<String, JsonValue>,
    },
    McpToolUpdate {
        id: i64,
        data: JsonMap<String, JsonValue>,
    },
    McpToolDelete {
        id: i64,
    },
    McpToolDeleteByServer {
        server_id: i64,
    },
    McpToolCount {
        server_id: Option<i64>,
    },
    McpToolSync {
        server_id: i64,
        tools: Vec<McpToolDefinition>,
    },
    BuiltInToolList {
        enabled_only: bool,
    },
    BuiltInToolFindById {
        id: i64,
    },
    BuiltInToolFindByToolId {
        tool_id: String,
    },
    BuiltInToolCreate {
        data: JsonMap<String, JsonValue>,
    },
    BuiltInToolUpdate {
        id: i64,
        data: JsonMap<String, JsonValue>,
    },
    BuiltInToolUpdateMany {
        ids: Vec<i64>,
        data: JsonMap<String, JsonValue>,
    },
    BuiltInToolTouch {
        tool_id: String,
        last_used_at: String,
    },
    BuiltInToolCountEnabled,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(crate) struct UpstreamMetadataEntry {
    pub model_id: String,
    pub metadata: JsonValue,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct CatalogModel {
    pub model_id: String,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpToolDefinition {
    pub name: String,
    pub description: Option<String>,
    pub input_schema: JsonValue,
    pub enabled: Option<i64>,
}

impl DatabaseOperation {
    pub(crate) fn surface(&self) -> OperationSurface {
        match self {
            Self::SettingFind { .. }
            | Self::SettingGet { .. }
            | Self::SettingSet { .. }
            | Self::StatisticGet { .. }
            | Self::StatisticSet { .. }
            | Self::MetaGet { .. }
            | Self::MetaSet { .. }
            | Self::MetaDelete { .. } => OperationSurface::new(OperationGroup::Settings),
            Self::QuickSearchFind { .. } | Self::QuickSearchUpsert { .. } => {
                OperationSurface::new(OperationGroup::Search)
            }
            Self::SessionCreate { .. }
            | Self::SessionFindById { .. }
            | Self::SessionList { .. }
            | Self::SessionUpdate { .. }
            | Self::SessionDismissTerminalStatus { .. }
            | Self::SessionRefreshMetadata { .. }
            | Self::SessionCount
            | Self::SessionDeleteAll => OperationSurface::new(OperationGroup::Agent),
            Self::ProviderList
            | Self::ProviderFind { .. }
            | Self::ProviderCreate { .. }
            | Self::ProviderUpdate { .. }
            | Self::ProviderDelete { .. }
            | Self::ModelListWithProvider { .. }
            | Self::ModelFindDefaultWithProvider
            | Self::ModelFindByProviderAndModelId { .. }
            | Self::ModelFindDefault
            | Self::ModelCreate { .. }
            | Self::ModelUpdate { .. }
            | Self::ModelDelete { .. }
            | Self::ModelSetDefault { .. }
            | Self::ModelRecordUpstreamMetadata { .. }
            | Self::ModelPersistCatalog { .. }
            | Self::ModelSyncMetadata
            | Self::LlmMetadataFind { .. }
            | Self::LlmMetadataInsert { .. }
            | Self::LlmMetadataClear
            | Self::LlmMetadataIsEmpty
            | Self::LlmMetadataAliasIsEmpty
            | Self::LlmMetadataFindPricing { .. }
            | Self::LlmMetadataCountPriced
            | Self::LlmMetadataReplace { .. }
            | Self::LlmMetadataMarkChecked { .. }
            | Self::McpServerList { .. }
            | Self::McpServerFindById { .. }
            | Self::McpServerFindByName { .. }
            | Self::McpServerCreate { .. }
            | Self::McpServerUpdate { .. }
            | Self::McpServerDelete { .. }
            | Self::McpServerCount
            | Self::McpToolList { .. }
            | Self::McpToolFindById { .. }
            | Self::McpToolFindByServerAndName { .. }
            | Self::McpToolCreate { .. }
            | Self::McpToolUpdate { .. }
            | Self::McpToolDelete { .. }
            | Self::McpToolDeleteByServer { .. }
            | Self::McpToolCount { .. }
            | Self::McpToolSync { .. }
            | Self::BuiltInToolList { .. }
            | Self::BuiltInToolFindById { .. }
            | Self::BuiltInToolFindByToolId { .. }
            | Self::BuiltInToolCreate { .. }
            | Self::BuiltInToolUpdate { .. }
            | Self::BuiltInToolUpdateMany { .. }
            | Self::BuiltInToolTouch { .. }
            | Self::BuiltInToolCountEnabled => OperationSurface::new(OperationGroup::Config),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DatabaseOperationError {
    pub code: &'static str,
    pub message: String,
}

impl DatabaseOperationError {
    pub(crate) fn validation(message: impl Into<String>) -> Self {
        Self {
            code: "database-validation",
            message: message.into(),
        }
    }

    pub(crate) fn not_found(message: impl Into<String>) -> Self {
        Self {
            code: "database-not-found",
            message: message.into(),
        }
    }

    pub(crate) fn forbidden(window_label: &str) -> Self {
        Self {
            code: "database-forbidden",
            message: format!(
                "Database operation is not allowed for window '{}'",
                window_label
            ),
        }
    }

    pub(crate) fn unavailable(message: impl Into<String>) -> Self {
        Self {
            code: "database-unavailable",
            message: message.into(),
        }
    }

    pub(crate) fn with_code(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl From<sqlx::Error> for DatabaseOperationError {
    fn from(error: sqlx::Error) -> Self {
        match error {
            sqlx::Error::RowNotFound => Self::not_found("Database row was not found"),
            sqlx::Error::Database(error) if error.is_unique_violation() => Self {
                code: "database-conflict",
                message: error.message().to_string(),
            },
            sqlx::Error::Database(error) if error.is_foreign_key_violation() => Self {
                code: "database-conflict",
                message: error.message().to_string(),
            },
            sqlx::Error::Database(error) => Self {
                code: "database-query",
                message: error.message().to_string(),
            },
            other => Self::unavailable(other.to_string()),
        }
    }
}

impl From<String> for DatabaseOperationError {
    fn from(message: String) -> Self {
        Self::validation(message)
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct OperationSurface {
    pub(crate) group: OperationGroup,
}

impl OperationSurface {
    const fn new(group: OperationGroup) -> Self {
        Self { group }
    }
}
