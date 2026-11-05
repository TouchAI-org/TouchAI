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
    SessionMessages {
        session_id: i64,
    },
    SessionHistory {
        session_id: i64,
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
    MessageCount,
    MessageDeleteAll,
    SessionTurnCount,
    SessionTurnDeleteAll,
    ToolPartCreate {
        tool_kind: ToolPartKind,
        data: JsonMap<String, JsonValue>,
    },
    ToolPartList {
        tool_kind: ToolPartKind,
        filter: ToolPartFilter,
        limit: Option<u32>,
        offset: Option<u32>,
    },
    ToolPartUpdate {
        tool_kind: ToolPartKind,
        filter: ToolPartFilter,
        data: JsonMap<String, JsonValue>,
    },
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
    AttachmentEnsure {
        input: AttachmentPersistInput,
    },
    AttachmentRemoteRefFind {
        attachment_id: i64,
        provider_id: i64,
        transport_kind: String,
    },
    AttachmentRemoteRefUpsert {
        data: AttachmentRemoteRefInput,
    },
    AttachmentRemoteRefTouch {
        id: i64,
        last_used_at: Option<String>,
    },
    TaskRecordStart {
        input: TaskRecordStartInput,
    },
    TaskPersistOutputMessage {
        input: TaskPersistOutputMessageInput,
    },
    TaskPersistToolResult {
        input: TaskPersistToolResultInput,
    },
    TaskUpdateAttempt {
        input: TaskUpdateAttemptInput,
    },
    TaskFinish {
        input: TaskFinishInput,
    },
    TaskBeginNextAttempt {
        input: TaskBeginNextAttemptInput,
    },
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
pub(crate) struct AttachmentPersistInput {
    pub attachment_id: Option<i64>,
    pub hash: Option<String>,
    #[serde(rename = "type")]
    pub attachment_type: String,
    pub original_name: String,
    pub origin_path: String,
    pub mime_type: Option<String>,
    pub size: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct AttachmentRemoteRefInput {
    pub attachment_id: i64,
    pub provider_id: i64,
    pub transport_kind: String,
    pub remote_ref: String,
    pub mime_type: Option<String>,
    pub expires_at: Option<String>,
    pub last_used_at: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OutputPartInput {
    #[serde(rename = "type")]
    pub part_type: String,
    pub content: String,
    pub data: Option<String>,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LlmCallPartInput {
    pub data: String,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageSummary {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub reasoning_tokens: i64,
    pub total_cost_micros: i64,
    pub unpriced_calls: i64,
    pub ttft_ms: Option<i64>,
    pub llm_call_count: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttemptUsageWrite {
    pub calls: Vec<LlmCallPartInput>,
    pub summary: UsageSummary,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TurnBehaviorSignals {
    pub first_text_ms: Option<i64>,
    pub tool_call_count: i64,
    pub tool_argument_error_count: i64,
    pub model_switch_count: i64,
    pub hit_iteration_ceiling: bool,
    pub error_code: Option<String>,
    pub retry_scope: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskRecordStartInput {
    pub session_id: Option<i64>,
    pub session_title: String,
    pub model_id: i64,
    pub model_name: String,
    pub provider_id: i64,
    pub task_id: String,
    pub execution_mode: String,
    pub prompt: String,
    pub prompt_snapshot_json: String,
    pub prompt_breakdown_json: Option<String>,
    pub checkpoint_json: String,
    pub delivery_manifest_json: String,
    pub started_at: String,
    pub max_retries: i64,
    pub existing_user_message_id: Option<i64>,
    pub existing_turn_id: Option<i64>,
    pub existing_attempt_id: Option<i64>,
    pub attachments: Vec<AttachmentPersistInput>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskPersistOutputMessageInput {
    pub session_id: i64,
    pub turn_id: Option<i64>,
    pub message_id: Option<i64>,
    pub role: String,
    pub link_turn: bool,
    pub parts: Vec<OutputPartInput>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskPersistToolResultInput {
    pub tool_call_part_id: Option<i64>,
    pub tool_call_id: Option<String>,
    pub tool_call_message_id: Option<i64>,
    pub result: String,
    pub attachments: Vec<AttachmentPersistInput>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskUpdateAttemptInput {
    pub attempt_id: i64,
    pub checkpoint_json: Option<String>,
    pub delivery_manifest_json: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskFinishInput {
    pub session_id: i64,
    pub turn_id: Option<i64>,
    pub attempt_id: Option<i64>,
    pub assistant_message_id: Option<i64>,
    pub pending_message_id: Option<i64>,
    pub status: String,
    pub error_message: Option<String>,
    pub duration_ms: Option<i64>,
    pub tokens_used: Option<i64>,
    pub finished_at: String,
    pub parts: Option<Vec<OutputPartInput>>,
    pub usage: Option<AttemptUsageWrite>,
    pub behavior: TurnBehaviorSignals,
    pub turn_bootstrap: Option<TaskTurnBootstrap>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskTurnBootstrap {
    pub model_id: i64,
    pub task_id: String,
    pub execution_mode: String,
    pub prompt_snapshot_json: String,
    pub prompt_message_id: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskBeginNextAttemptInput {
    pub turn_id: i64,
    pub current_attempt_id: i64,
    pub current_attempt_index: i64,
    pub error_message: String,
    pub duration_ms: Option<i64>,
    pub finished_at: String,
    pub attempt_index: i64,
    pub max_retries: i64,
    pub checkpoint_json: String,
    pub delivery_manifest_json: String,
    pub started_at: String,
    pub usage: Option<AttemptUsageWrite>,
    pub behavior: TurnBehaviorSignals,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ToolPartKind {
    Mcp,
    Builtin,
}

impl ToolPartKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Mcp => "mcp",
            Self::Builtin => "builtin",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub(crate) enum ToolPartFilter {
    Id { id: i64 },
    ToolCallId { tool_call_id: String },
    ServerId { server_id: i64 },
    ToolId { tool_id: String },
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
            | Self::SessionMessages { .. }
            | Self::SessionHistory { .. }
            | Self::SessionUpdate { .. }
            | Self::SessionDismissTerminalStatus { .. }
            | Self::SessionRefreshMetadata { .. }
            | Self::SessionCount
            | Self::SessionDeleteAll
            | Self::MessageCount
            | Self::MessageDeleteAll
            | Self::SessionTurnCount
            | Self::SessionTurnDeleteAll => OperationSurface::new(OperationGroup::Agent),
            Self::ToolPartCreate { .. } | Self::ToolPartUpdate { .. } => {
                OperationSurface::new(OperationGroup::Agent)
            }
            Self::ToolPartList { .. } => OperationSurface::new(OperationGroup::ToolHistory),
            Self::TaskRecordStart { .. }
            | Self::TaskPersistOutputMessage { .. }
            | Self::TaskPersistToolResult { .. }
            | Self::TaskUpdateAttempt { .. }
            | Self::TaskFinish { .. }
            | Self::TaskBeginNextAttempt { .. } => OperationSurface::new(OperationGroup::Agent),
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
            Self::AttachmentEnsure { .. }
            | Self::AttachmentRemoteRefFind { .. }
            | Self::AttachmentRemoteRefUpsert { .. }
            | Self::AttachmentRemoteRefTouch { .. } => OperationSurface::new(OperationGroup::Agent),
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
