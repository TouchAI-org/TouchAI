// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type {
    MessageRole,
    ProviderType,
    RequestStatus,
    SettingKey,
    StatisticKey,
    ToolLogStatus,
    TransportType,
} from '../schema';

// ==================== 基础类型 ====================

export type SettingIdentifier = string | SettingKey;
export type StatisticIdentifier = string | StatisticKey;

export type DbMessageRole = MessageRole;
export type DbProviderType = ProviderType;
export type DbRequestStatus = RequestStatus;
export type DbTransportType = TransportType;
export type DbToolLogStatus = ToolLogStatus;

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
    created_at: string;
    updated_at: string;
}

export interface MessageCreateData {
    session_id: number;
    role: DbMessageRole;
    content: string;
    tool_log_id?: number | null;
    created_at?: string;
    updated_at?: string;
}

export interface AttachmentEntity {
    id: number;
    hash: string;
    type: 'image' | 'file';
    original_name: string;
    mime_type: string | null;
    size: number | null;
    created_at: string;
}

export interface AttachmentCreateData {
    hash: string;
    type: 'image' | 'file';
    original_name: string;
    mime_type?: string | null;
    size?: number | null;
    created_at?: string;
}

export interface MessageAttachmentEntity {
    id: number;
    message_id: number;
    attachment_id: number;
    sort_order: number;
    created_at: string;
}

export interface MessageAttachmentCreateData {
    message_id: number;
    attachment_id: number;
    sort_order?: number;
    created_at?: string;
}

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
    type: DbProviderType;
    api_endpoint: string;
    api_key: string | null;
    logo: string;
    enabled: number;
    is_builtin: number;
    created_at: string;
    updated_at: string;
}

export interface ProviderCreateData {
    name: string;
    type: DbProviderType;
    api_endpoint: string;
    api_key?: string | null;
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
    provider_type: DbProviderType;
    api_endpoint: string;
    api_key: string | null;
    provider_enabled: number;
    provider_logo: string;
}

// ==================== AI 请求 ====================

export interface AiRequestEntity {
    id: number;
    session_id: number | null;
    model_id: number;
    prompt_message_id: number | null;
    response_message_id: number | null;
    status: DbRequestStatus;
    error_message: string | null;
    tokens_used: number | null;
    duration_ms: number | null;
    created_at: string;
    updated_at: string;
}

export interface AiRequestCreateData {
    session_id?: number | null;
    model_id: number;
    prompt_message_id?: number | null;
    response_message_id?: number | null;
    status?: DbRequestStatus;
    error_message?: string | null;
    tokens_used?: number | null;
    duration_ms?: number | null;
    created_at?: string;
    updated_at?: string;
}

export type AiRequestUpdateData = Partial<AiRequestCreateData>;

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
