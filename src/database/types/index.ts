// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type {
    BuiltInToolLog,
    MessageRole,
    ProviderDriver,
    SettingKey,
    StatisticKey,
    ToolLogKind,
    ToolLogStatus,
    TransportType,
    TurnStatus,
} from '../schema';

// ==================== 基础类型 ====================

export type SettingIdentifier = string | SettingKey;
export type StatisticIdentifier = string | StatisticKey;

export type DbMessageRole = MessageRole;
export type DbProviderDriver = ProviderDriver;
export type DbTurnStatus = TurnStatus;
export type DbRequestStatus = TurnStatus;
export type DbTransportType = TransportType;
export type DbToolLogStatus = ToolLogStatus;
export type DbToolLogKind = ToolLogKind;

// ==================== 通用请求对象 ====================

export interface SessionIdPayload {
    sessionId: number;
}

export interface ProviderIdPayload {
    providerId: number;
}

// ==================== 会话 ====================

export interface SessionEntity {
    id: number;
    session_id: string;
    title: string;
    model: string;
    provider_id: number | null;
    last_message_preview: string | null;
    last_message_at: string | null;
    message_count: number;
    status_badge_dismissed_turn_id: number | null;
    pending_terminal_status: 'completed' | 'failed' | null;
    pinned_at: string | null;
    archived_at: string | null;
    created_at: string;
    updated_at: string;
}

export interface SessionCreateData {
    session_id: string;
    title: string;
    model: string;
    provider_id?: number | null;
    last_message_preview?: string | null;
    last_message_at?: string | null;
    message_count?: number;
    status_badge_dismissed_turn_id?: number | null;
    pinned_at?: string | null;
    archived_at?: string | null;
    created_at?: string;
    updated_at?: string;
}

export type SessionUpdateData = Partial<SessionCreateData>;

// ==================== 消息 ====================

export interface MessageEntity {
    id: number;
    session_id: number;
    role: DbMessageRole;
    content: string;
    tool_log_id: number | null;
    tool_log_kind: DbToolLogKind | null;
    created_at: string;
    updated_at: string;
}

export interface MessageCreateData {
    session_id: number;
    role: DbMessageRole;
    content: string;
    tool_log_id?: number | null;
    tool_log_kind?: DbToolLogKind | null;
    created_at?: string;
    updated_at?: string;
}

export interface AttachmentEntity {
    id: number;
    hash: string;
    type: 'image' | 'file';
    original_name: string;
    origin_path: string;
    mime_type: string | null;
    size: number | null;
    created_at: string;
}

export interface AttachmentCreateData {
    hash: string;
    type: 'image' | 'file';
    original_name: string;
    origin_path: string;
    mime_type?: string | null;
    size?: number | null;
    created_at?: string;
}

export interface MessageAttachmentEntity {
    id: number;
    message_id: number;
    attachment_id: number;
    sort_order: number;
    origin_path: string;
    created_at: string;
}

export interface MessageAttachmentCreateData {
    message_id: number;
    attachment_id: number;
    sort_order?: number;
    origin_path: string;
    created_at?: string;
}

export interface AttachmentRemoteRefEntity {
    id: number;
    attachment_id: number;
    provider_id: number;
    transport_kind: string;
    remote_ref: string;
    mime_type: string | null;
    expires_at: string | null;
    last_used_at: string | null;
    created_at: string;
    updated_at: string;
}

export interface AttachmentRemoteRefCreateData {
    attachment_id: number;
    provider_id: number;
    transport_kind: string;
    remote_ref: string;
    mime_type?: string | null;
    expires_at?: string | null;
    last_used_at?: string | null;
    created_at?: string;
    updated_at?: string;
}

export type AttachmentRemoteRefUpdateData = Partial<AttachmentRemoteRefCreateData>;

// ==================== 设置 ====================

export interface SettingEntity {
    id: number;
    key: string;
    value: string | null;
    created_at: string;
    updated_at: string;
}

// ==================== 统计 ====================

// ==================== 元数据（touchai_meta） ====================

// ==================== 服务商 ====================

export interface ProviderEntity {
    id: number;
    name: string;
    driver: DbProviderDriver;
    api_endpoint: string;
    api_key: string | null;
    config_json: string | null;
    logo: string;
    enabled: number;
    is_builtin: number;
    created_at: string;
    updated_at: string;
}

export interface ProviderCreateData {
    name: string;
    driver: DbProviderDriver;
    api_endpoint: string;
    api_key?: string | null;
    config_json?: string | null;
    logo: string;
    enabled?: number;
    is_builtin?: number;
    created_at?: string;
    updated_at?: string;
}

export type ProviderUpdateData = Partial<ProviderCreateData>;

// ==================== 模型 ====================

export interface ModelEntity {
    id: number;
    provider_id: number;
    name: string;
    model_id: string;
    is_default: number;
    last_used_at: string | null;
    attachment: number;
    modalities: string | null;
    open_weights: number;
    reasoning: number;
    release_date: string | null;
    temperature: number;
    tool_call: number;
    knowledge: string | null;
    context_limit: number | null;
    output_limit: number | null;
    is_custom_metadata: number;
    created_at: string;
    updated_at: string;
}

export interface ModelCreateData {
    provider_id: number;
    name: string;
    model_id: string;
    is_default?: number;
    last_used_at?: string | null;
    attachment?: number;
    modalities?: string | null;
    open_weights?: number;
    reasoning?: number;
    release_date?: string | null;
    temperature?: number;
    tool_call?: number;
    knowledge?: string | null;
    context_limit?: number | null;
    output_limit?: number | null;
    is_custom_metadata?: number;
    created_at?: string;
    updated_at?: string;
}

export type ModelUpdateData = Partial<ModelCreateData>;

export interface ProviderModelLookupPayload extends ProviderIdPayload {
    modelId: string;
}

export interface FindModelsWithProviderPayload {
    providerId?: number;
}

export interface ModelWithProvider {
    id: number;
    created_at: string;
    updated_at: string;
    provider_id: number;
    model_id: string;
    name: string;
    is_default: number;
    last_used_at: string | null;
    attachment: number;
    modalities: string | null;
    open_weights: number;
    reasoning: number;
    release_date: string | null;
    temperature: number;
    tool_call: number;
    knowledge: string | null;
    context_limit: number | null;
    output_limit: number | null;
    is_custom_metadata: number;
    provider_name: string;
    provider_driver: DbProviderDriver;
    api_endpoint: string;
    api_key: string | null;
    provider_config_json: string | null;
    provider_enabled: number;
    provider_logo: string;
}

// ==================== 会话轮次 ====================

export interface SessionTurnEntity {
    id: number;
    session_id: number | null;
    model_id: number;
    task_id: string;
    execution_mode: 'foreground' | 'background';
    prompt_snapshot_json: string;
    prompt_message_id: number | null;
    response_message_id: number | null;
    status: DbTurnStatus;
    error_message: string | null;
    tokens_used: number | null;
    duration_ms: number | null;
    created_at: string;
    updated_at: string;
}

export interface SessionTurnCreateData {
    session_id?: number | null;
    model_id: number;
    task_id: string;
    execution_mode?: 'foreground' | 'background';
    prompt_snapshot_json: string;
    prompt_message_id?: number | null;
    response_message_id?: number | null;
    status?: DbTurnStatus;
    error_message?: string | null;
    tokens_used?: number | null;
    duration_ms?: number | null;
    created_at?: string;
    updated_at?: string;
}

export type SessionTurnUpdateData = Partial<SessionTurnCreateData>;

export interface SessionTurnAttemptEntity {
    id: number;
    turn_id: number;
    attempt_index: number;
    max_retries: number;
    status: DbTurnStatus;
    checkpoint_json: string;
    delivery_manifest_json: string;
    error_message: string | null;
    duration_ms: number | null;
    started_at: string;
    finished_at: string | null;
    created_at: string;
    updated_at: string;
}

export interface SessionTurnAttemptCreateData {
    turn_id: number;
    attempt_index: number;
    max_retries?: number;
    status?: DbTurnStatus;
    checkpoint_json: string;
    delivery_manifest_json: string;
    error_message?: string | null;
    duration_ms?: number | null;
    started_at?: string;
    finished_at?: string | null;
    created_at?: string;
    updated_at?: string;
}

export type SessionTurnAttemptUpdateData = Partial<SessionTurnAttemptCreateData>;

// ==================== LLM 元数据 ====================

export interface LlmMetadataEntity {
    id: number;
    model_id: string;
    name: string;
    attachment: number;
    modalities: string;
    open_weights: number;
    reasoning: number;
    release_date: string | null;
    temperature: number;
    tool_call: number;
    knowledge: string | null;
    limit: string | null;
    created_at: string;
    updated_at: string;
}

export interface LlmMetadataCreateData {
    model_id: string;
    name: string;
    attachment?: number;
    modalities: string;
    open_weights?: number;
    reasoning?: number;
    release_date?: string | null;
    temperature?: number;
    tool_call?: number;
    knowledge?: string | null;
    limit?: string | null;
    created_at?: string;
    updated_at?: string;
}

// ==================== MCP 服务器 ====================

export interface McpServerEntity {
    id: number;
    name: string;
    transport_type: DbTransportType;
    command: string | null;
    args: string | null;
    env: string | null;
    cwd: string | null;
    url: string | null;
    headers: string | null;
    enabled: number;
    tool_timeout: number;
    version: string | null;
    last_error: string | null;
    last_connected_at: string | null;
    created_at: string;
    updated_at: string;
}

export interface McpServerCreateData {
    name: string;
    transport_type: DbTransportType;
    command?: string | null;
    args?: string | null;
    env?: string | null;
    cwd?: string | null;
    url?: string | null;
    headers?: string | null;
    enabled?: number;
    tool_timeout?: number;
    version?: string | null;
    last_error?: string | null;
    last_connected_at?: string | null;
    created_at?: string;
    updated_at?: string;
}
export type McpServerUpdateData = Partial<McpServerCreateData>;

// ==================== MCP 工具 ====================

export interface McpToolEntity {
    id: number;
    server_id: number;
    name: string;
    description: string | null;
    input_schema: string;
    enabled: number;
    created_at: string;
    updated_at: string;
}

export interface McpToolCreateData {
    server_id: number;
    name: string;
    description?: string | null;
    input_schema: string;
    enabled?: number;
    created_at?: string;
    updated_at?: string;
}

export type McpToolUpdateData = Partial<McpToolCreateData>;

// ==================== MCP 工具日志 ====================

export interface McpToolLogEntity {
    id: number;
    server_id: number;
    tool_name: string;
    tool_call_id: string;
    session_id: number | null;
    message_id: number | null;
    iteration: number;
    input: string;
    output: string | null;
    status: DbToolLogStatus;
    duration_ms: number | null;
    error_message: string | null;
    created_at: string;
}

export interface McpToolLogCreateData {
    server_id: number;
    tool_name: string;
    tool_call_id: string;
    session_id?: number | null;
    message_id?: number | null;
    iteration?: number;
    input: string;
    output?: string | null;
    status?: DbToolLogStatus;
    duration_ms?: number | null;
    error_message?: string | null;
    created_at?: string;
}

export type McpToolLogUpdateData = Partial<McpToolLogCreateData>;

// ==================== 内置工具 ====================

export type BuiltInToolRiskLevel = 'low' | 'medium' | 'high';
export type BuiltInToolLogStatus = BuiltInToolLog['status'];
export type BuiltInToolApprovalState = BuiltInToolLog['approval_state'];

export interface BuiltInToolEntity {
    id: number;
    tool_id: string;
    display_name: string;
    description: string | null;
    enabled: number;
    risk_level: BuiltInToolRiskLevel;
    config_json: string | null;
    last_used_at: string | null;
    created_at: string;
    updated_at: string;
}

export interface BuiltInToolCreateData {
    tool_id: string;
    display_name: string;
    description?: string | null;
    enabled?: number;
    risk_level?: BuiltInToolRiskLevel;
    config_json?: string | null;
    last_used_at?: string | null;
    created_at?: string;
    updated_at?: string;
}

export type BuiltInToolUpdateData = Partial<BuiltInToolCreateData>;

export interface BuiltInToolLogEntity {
    id: number;
    tool_id: string;
    tool_call_id: string;
    session_id: number | null;
    message_id: number | null;
    iteration: number;
    input: string;
    output: string | null;
    status: BuiltInToolLogStatus;
    approval_state: BuiltInToolApprovalState;
    approval_summary: string | null;
    duration_ms: number | null;
    error_message: string | null;
    created_at: string;
}

export interface BuiltInToolLogCreateData {
    tool_id: string;
    tool_call_id: string;
    session_id?: number | null;
    message_id?: number | null;
    iteration?: number;
    input: string;
    output?: string | null;
    status?: BuiltInToolLogStatus;
    approval_state?: BuiltInToolApprovalState;
    approval_summary?: string | null;
    duration_ms?: number | null;
    error_message?: string | null;
    created_at?: string;
}

export type BuiltInToolLogUpdateData = Partial<BuiltInToolLogCreateData>;
