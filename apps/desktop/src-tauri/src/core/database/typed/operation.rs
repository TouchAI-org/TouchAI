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
    SettingGetMany {
        keys: Vec<String>,
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
    QuickSearchFindRecent {
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
    SessionContext {
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
    ToolPartSummaries {
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
    UsageSummary {
        filter: UsageFilterInput,
    },
    UsageDashboard {
        filter: UsageFilterInput,
        task_ids: Vec<String>,
        dimension: UsageDimension,
    },
    UsageTrend {
        filter: UsageFilterInput,
        dimension: UsageDimension,
    },
    UsageArchiveTrend,
    UsageByModel {
        filter: UsageFilterInput,
    },
    UsageByProvider {
        filter: UsageFilterInput,
    },
    UsageModelRanking {
        filter: UsageFilterInput,
        metric: UsageRankMetric,
        limit: u32,
    },
    UsageSessionRanking {
        filter: UsageFilterInput,
        metric: UsageRankMetric,
        limit: u32,
    },
    UsageFilterOptions {
        filter: UsageFilterInput,
    },
    UsageComposition {
        filter: UsageFilterInput,
    },
    UsageToolStats {
        filter: UsageFilterInput,
    },
    UsageHeatmap {
        filter: UsageFilterInput,
    },
    UsageContextProfiles {
        filter: UsageFilterInput,
    },
    UsageContextPoints {
        filter: UsageFilterInput,
        limit: u32,
    },
    UsageAppendLlmCallParts {
        message_id: i64,
        calls: Vec<LlmCallPartInput>,
    },
    UsageRollupDaily,
    UsagePruneDetail {
        retention_days: f64,
    },
    UsageMaintenance {
        retention_days: f64,
        min_interval_ms: i64,
        now: String,
        statistic_key: String,
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
    TaskPersistContextSummary {
        input: TaskPersistContextSummaryInput,
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
pub(crate) struct UsageFilterInput {
    pub from: String,
    pub to: String,
    pub model_ids: Option<Vec<i64>>,
    pub provider_ids: Option<Vec<i64>>,
    pub statuses: Option<Vec<String>>,
    pub only_failed: Option<bool>,
    pub only_retried: Option<bool>,
    pub search: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum UsageDimension {
    Model,
    Provider,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum UsageRankMetric {
    Tokens,
    Cost,
    Duration,
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
pub(crate) struct ContextMessageFingerprintInput {
    pub id: i64,
    pub fingerprint: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskPersistContextSummaryInput {
    pub session_id: i64,
    pub turn_id: i64,
    pub attempt_id: i64,
    pub pending_message_id: Option<i64>,
    pub summary_json: String,
    pub text: String,
    pub previous_summary_json: Option<String>,
    pub source_messages: Vec<ContextMessageFingerprintInput>,
    pub usage: Option<AttemptUsageWrite>,
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
            | Self::SettingGetMany { .. }
            | Self::StatisticGet { .. }
            | Self::MetaGet { .. } => OperationSurface::new(OperationGroup::Settings),
            Self::SettingSet { .. }
            | Self::StatisticSet { .. }
            | Self::MetaSet { .. }
            | Self::MetaDelete { .. } => OperationSurface::new(OperationGroup::SettingsWrite),
            Self::QuickSearchFind { .. }
            | Self::QuickSearchFindRecent { .. }
            | Self::QuickSearchUpsert { .. } => OperationSurface::new(OperationGroup::Search),
            Self::SessionCreate { .. }
            | Self::SessionFindById { .. }
            | Self::SessionList { .. }
            | Self::SessionMessages { .. }
            | Self::SessionContext { .. }
            | Self::SessionHistory { .. }
            | Self::SessionUpdate { .. }
            | Self::SessionDismissTerminalStatus { .. }
            | Self::SessionRefreshMetadata { .. } => OperationSurface::new(OperationGroup::Agent),
            Self::SessionCount
            | Self::SessionDeleteAll
            | Self::MessageCount
            | Self::MessageDeleteAll
            | Self::SessionTurnCount
            | Self::SessionTurnDeleteAll => OperationSurface::new(OperationGroup::Maintenance),
            Self::ToolPartCreate { .. } | Self::ToolPartUpdate { .. } => {
                OperationSurface::new(OperationGroup::Agent)
            }
            Self::ToolPartList { .. } | Self::ToolPartSummaries { .. } => {
                OperationSurface::new(OperationGroup::ToolHistory)
            }
            Self::TaskRecordStart { .. }
            | Self::TaskPersistOutputMessage { .. }
            | Self::TaskPersistToolResult { .. }
            | Self::TaskUpdateAttempt { .. }
            | Self::TaskFinish { .. }
            | Self::TaskBeginNextAttempt { .. }
            | Self::TaskPersistContextSummary { .. } => {
                OperationSurface::new(OperationGroup::Agent)
            }
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
            Self::UsageSummary { .. }
            | Self::UsageDashboard { .. }
            | Self::UsageTrend { .. }
            | Self::UsageArchiveTrend
            | Self::UsageByModel { .. }
            | Self::UsageByProvider { .. }
            | Self::UsageModelRanking { .. }
            | Self::UsageSessionRanking { .. }
            | Self::UsageFilterOptions { .. }
            | Self::UsageComposition { .. }
            | Self::UsageToolStats { .. }
            | Self::UsageHeatmap { .. }
            | Self::UsageContextProfiles { .. }
            | Self::UsageContextPoints { .. } => OperationSurface::new(OperationGroup::Usage),
            Self::UsageAppendLlmCallParts { .. }
            | Self::UsageRollupDaily
            | Self::UsagePruneDetail { .. }
            | Self::UsageMaintenance { .. } => OperationSurface::new(OperationGroup::UsageWrite),
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
    /// Validation and not-found codes keep their stable category, but the diagnostic
    /// text (field names, row ids, table names, SQL) stays in the log. Callers only
    /// observe the fixed public message for the category.
    pub(crate) fn validation(diagnostic: impl std::fmt::Display) -> Self {
        log::error!(target: "database", "Database operation received invalid data: {diagnostic}");
        Self {
            code: "database-validation",
            message: public_database_error_message("database-validation").to_string(),
        }
    }

    pub(crate) fn not_found(diagnostic: impl std::fmt::Display) -> Self {
        log::debug!(target: "database", "Database row was not found: {diagnostic}");
        Self {
            code: "database-not-found",
            message: public_database_error_message("database-not-found").to_string(),
        }
    }

    pub(crate) fn forbidden(window_label: &str) -> Self {
        log::warn!(
            target: "database",
            "Database operation was denied for window '{window_label}'"
        );
        Self {
            code: "database-forbidden",
            message: "Database operation is not allowed for this window".to_string(),
        }
    }

    pub(crate) fn backup_failed(diagnostic: impl std::fmt::Display) -> Self {
        log::error!(target: "database", "Database backup export failed: {diagnostic}");
        Self {
            code: "database-backup-failed",
            message: public_database_error_message("database-backup-failed").to_string(),
        }
    }

    pub(crate) fn import_failed(diagnostic: impl std::fmt::Display) -> Self {
        log::error!(target: "database", "Database backup import failed: {diagnostic}");
        Self {
            code: "database-import-failed",
            message: public_database_error_message("database-import-failed").to_string(),
        }
    }

    pub(crate) fn unavailable(diagnostic: impl std::fmt::Display) -> Self {
        log::error!(target: "database", "Database operation is unavailable: {diagnostic}");
        Self {
            code: "database-unavailable",
            message: public_database_error_message("database-unavailable").to_string(),
        }
    }

    pub(crate) fn invalid_data(diagnostic: impl std::fmt::Display) -> Self {
        Self::validation(diagnostic)
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
        let code = match &error {
            sqlx::Error::RowNotFound => "database-not-found",
            sqlx::Error::Database(error)
                if error.is_unique_violation() || error.is_foreign_key_violation() =>
            {
                "database-conflict"
            }
            sqlx::Error::Database(error) => error
                .code()
                .and_then(|code| code.parse::<i32>().ok())
                .map(sqlite_error_code)
                .unwrap_or("database-query"),
            _ => "database-unavailable",
        };

        if code == "database-not-found" {
            log::debug!(target: "database", "Database row was not found: {error}");
        } else {
            log::error!(target: "database", "Database operation failed: {error}");
        }

        Self {
            code,
            message: public_database_error_message(code).to_string(),
        }
    }
}

fn public_database_error_message(code: &str) -> &'static str {
    match code {
        "database-busy" => "Database is busy",
        "database-locked" => "Database is locked",
        "database-conflict" => "Database operation conflicts with existing data",
        "database-backup-failed" => "Database backup export failed",
        "database-import-failed" => "Database backup import failed",
        "database-not-found" => "Database record was not found",
        "database-unavailable" => "Database operation is unavailable",
        "database-validation" => "Database operation received invalid data",
        _ => "Database operation failed",
    }
}

fn sqlite_error_code(code: i32) -> &'static str {
    // SQLite exposes extended result codes here. The primary code is the low
    // byte (for example BUSY_SNAPSHOT -> BUSY).
    match code & 0xff {
        5 => "database-busy",
        6 => "database-locked",
        _ => "database-query",
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct OperationSurface {
    pub(crate) group: OperationGroup,
}

impl OperationSurface {
    pub(crate) const fn new(group: OperationGroup) -> Self {
        Self { group }
    }
}

#[cfg(test)]
mod tests {
    use super::{public_database_error_message, sqlite_error_code, DatabaseOperationError};

    #[test]
    fn user_sees_busy_and_locked_as_distinct_database_error_codes() {
        assert_eq!(sqlite_error_code(5), "database-busy");
        assert_eq!(sqlite_error_code(261), "database-busy");
        assert_eq!(sqlite_error_code(6), "database-locked");
        assert_eq!(sqlite_error_code(262), "database-locked");
        assert_eq!(sqlite_error_code(1), "database-query");
    }

    #[test]
    fn user_never_receives_raw_database_error_text() {
        assert_eq!(
            public_database_error_message("database-busy"),
            "Database is busy"
        );
        assert_eq!(
            public_database_error_message("database-locked"),
            "Database is locked"
        );
        assert_eq!(
            public_database_error_message("database-conflict"),
            "Database operation conflicts with existing data"
        );
        assert_eq!(
            public_database_error_message("database-unavailable"),
            "Database operation is unavailable"
        );
        assert_eq!(
            public_database_error_message("database-validation"),
            "Database operation received invalid data"
        );
        assert_eq!(
            public_database_error_message("database-query"),
            "Database operation failed"
        );
    }

    #[test]
    fn user_never_receives_validation_or_not_found_diagnostics() {
        let validation = DatabaseOperationError::validation("Unsupported field 'api_key'");
        assert_eq!(validation.code, "database-validation");
        assert_eq!(
            validation.message,
            "Database operation received invalid data"
        );
        assert!(!validation.message.contains("api_key"));
        assert!(!validation.message.contains("Unsupported"));

        let not_found = DatabaseOperationError::not_found("row 42 missing");
        assert_eq!(not_found.code, "database-not-found");
        assert_eq!(not_found.message, "Database record was not found");
        assert!(!not_found.message.contains("42"));
        assert!(!not_found.message.contains("row"));
    }
}
