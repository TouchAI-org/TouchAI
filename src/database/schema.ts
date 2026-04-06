// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

// ==================== Tauri 相关类型 ====================

/**
 * SQL 参数类型
 */
export type SqlValue = string | number | boolean | null | Uint8Array;

/**
 * SQL 参数类型
 */
export type SqlParams = SqlValue[];

// ==================== 表定义（Drizzle） ====================

/**
 * 设置键枚举
 */
export enum SettingKey {
    THEME = 'theme',
    LANGUAGE = 'language',
    AUTO_START = 'auto_start',
    MCP_MAX_ITERATIONS = 'mcp_max_iterations',
    OUTPUT_SCROLL_BEHAVIOR = 'output_scroll_behavior',
}

export type ToolLogKind = 'mcp' | 'builtin';

/**
 * 统计键枚举
 */
export enum StatisticKey {
    MODEL_METADATA_LAST_UPDATED_AT = 'model_metadata_last_updated_at',
}

/**
 * 元数据键枚举
 */
export enum MetaKey {
    APP_ID = 'app_id',
    IMPORT_SUCCESS = 'import_success',
}

/**
 * 会话表
 */
export const sessions = sqliteTable(
    'sessions',
    {
        id: integer('id').primaryKey({ autoIncrement: true }),
        session_id: text('session_id').notNull().unique(),
        title: text('title').notNull(),
        model: text('model').notNull(),
        provider_id: integer('provider_id').references(() => providers.id, {
            onDelete: 'set null',
        }),
        last_message_preview: text('last_message_preview'),
        last_message_at: text('last_message_at'),
        message_count: integer('message_count').notNull().default(0),
        pinned_at: text('pinned_at'),
        archived_at: text('archived_at'),
        created_at: text('created_at')
            .notNull()
            .default(sql`(datetime('now'))`),
        updated_at: text('updated_at')
            .notNull()
            .default(sql`(datetime('now'))`),
    },
    (table) => [
        index('sessions_provider_id_idx').on(table.provider_id),
        index('sessions_archived_at_idx').on(table.archived_at),
        index('sessions_pinned_at_idx').on(table.pinned_at),
        index('sessions_last_message_at_idx').on(table.last_message_at),
    ]
);

/**
 * 消息表
 */
export const messages = sqliteTable('messages', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    session_id: integer('session_id')
        .notNull()
        .references(() => sessions.id, { onDelete: 'cascade' }),
    role: text('role', {
        enum: ['user', 'assistant', 'system', 'tool_call', 'tool_result'],
    }).notNull(),
    content: text('content').notNull(),
    tool_log_id: integer('tool_log_id'), // 关联 mcp_tool_logs 表 ID（仅 tool_result 消息使用）
    tool_log_kind: text('tool_log_kind', {
        enum: ['mcp', 'builtin'],
    }),
    created_at: text('created_at')
        .notNull()
        .default(sql`(datetime('now'))`),
    updated_at: text('updated_at')
        .notNull()
        .default(sql`(datetime('now'))`),
});

/**
 * 附件缓存表
 */
export const attachments = sqliteTable('attachments', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    hash: text('hash').notNull().unique(),
    type: text('type', { enum: ['image', 'file'] }).notNull(),
    original_name: text('original_name').notNull(),
    mime_type: text('mime_type'),
    size: integer('size'),
    created_at: text('created_at')
        .notNull()
        .default(sql`(datetime('now'))`),
});

/**
 * 消息附件关联表
 */
export const messageAttachments = sqliteTable('message_attachments', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    message_id: integer('message_id')
        .notNull()
        .references(() => messages.id, { onDelete: 'cascade' }),
    attachment_id: integer('attachment_id')
        .notNull()
        .references(() => attachments.id, { onDelete: 'cascade' }),
    sort_order: integer('sort_order').notNull().default(0),
    created_at: text('created_at')
        .notNull()
        .default(sql`(datetime('now'))`),
});

/**
 * 设置表
 */
export const settings = sqliteTable('settings', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    key: text('key').notNull().unique(),
    value: text('value'),
    created_at: text('created_at')
        .notNull()
        .default(sql`(datetime('now'))`),
    updated_at: text('updated_at')
        .notNull()
        .default(sql`(datetime('now'))`),
});

/**
 * 统计表
 */
export const statistics = sqliteTable('statistics', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    key: text('key').notNull().unique(),
    value: text('value'),
    created_at: text('created_at')
        .notNull()
        .default(sql`(datetime('now'))`),
    updated_at: text('updated_at')
        .notNull()
        .default(sql`(datetime('now'))`),
});

/**
 * 应用元数据表
 * 用于存储应用级别的状态信息，如数据库标识、更新状态等
 */
export const touchaiMeta = sqliteTable('touchai_meta', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    key: text('key').notNull().unique(),
    value: text('value'),
    created_at: text('created_at')
        .notNull()
        .default(sql`(datetime('now'))`),
    updated_at: text('updated_at')
        .notNull()
        .default(sql`(datetime('now'))`),
});

/**
 * AI 服务商表
 */
export const providers = sqliteTable('providers', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    driver: text('driver', {
        enum: [
            'openai',
            'anthropic',
            'google',
            'deepseek',
            'xai',
            'moonshot',
            'alibaba',
            'minimax',
            'zhipu',
        ],
    }).notNull(),
    api_endpoint: text('api_endpoint').notNull(),
    api_key: text('api_key'),
    config_json: text('config_json'),
    logo: text('logo').notNull(),
    enabled: integer('enabled').notNull().default(1),
    is_builtin: integer('is_builtin').notNull().default(0),
    created_at: text('created_at')
        .notNull()
        .default(sql`(datetime('now'))`),
    updated_at: text('updated_at')
        .notNull()
        .default(sql`(datetime('now'))`),
});

/**
 * AI 模型表
 */
export const models = sqliteTable('models', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    provider_id: integer('provider_id')
        .notNull()
        .references(() => providers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    model_id: text('model_id').notNull(),
    is_default: integer('is_default').notNull().default(0),
    last_used_at: text('last_used_at'),
    // 元数据字段
    attachment: integer('attachment').notNull().default(0),
    modalities: text('modalities'), // JSON string: {input: [], output: []}
    open_weights: integer('open_weights').notNull().default(0),
    reasoning: integer('reasoning').notNull().default(0),
    release_date: text('release_date'),
    temperature: integer('temperature').notNull().default(1),
    tool_call: integer('tool_call').notNull().default(0),
    knowledge: text('knowledge'),
    context_limit: integer('context_limit'),
    output_limit: integer('output_limit'),
    is_custom_metadata: integer('is_custom_metadata').notNull().default(0), // 用户是否自定义了元数据
    created_at: text('created_at')
        .notNull()
        .default(sql`(datetime('now'))`),
    updated_at: text('updated_at')
        .notNull()
        .default(sql`(datetime('now'))`),
});

/**
 * 会话轮次表
 */
export const sessionTurns = sqliteTable(
    'session_turns',
    {
        id: integer('id').primaryKey({ autoIncrement: true }),
        session_id: integer('session_id').references(() => sessions.id, { onDelete: 'set null' }),
        model_id: integer('model_id')
            .notNull()
            .references(() => models.id, { onDelete: 'cascade' }),
        task_id: text('task_id').notNull(),
        execution_mode: text('execution_mode', {
            enum: ['foreground', 'background'],
        })
            .notNull()
            .default('foreground'),
        prompt_snapshot_json: text('prompt_snapshot_json').notNull(),
        prompt_message_id: integer('prompt_message_id').references(() => messages.id, {
            onDelete: 'set null',
        }),
        response_message_id: integer('response_message_id').references(() => messages.id, {
            onDelete: 'set null',
        }),
        status: text('status', {
            enum: ['pending', 'streaming', 'completed', 'failed', 'cancelled'],
        })
            .notNull()
            .default('pending'),
        error_message: text('error_message'),
        tokens_used: integer('tokens_used'),
        duration_ms: integer('duration_ms'),
        created_at: text('created_at')
            .notNull()
            .default(sql`(datetime('now'))`),
        updated_at: text('updated_at')
            .notNull()
            .default(sql`(datetime('now'))`),
    },
    (table) => [index('session_turns_session_id_idx').on(table.session_id)]
);

/**
 * 会话轮次尝试表
 */
export const sessionTurnAttempts = sqliteTable(
    'session_turn_attempts',
    {
        id: integer('id').primaryKey({ autoIncrement: true }),
        turn_id: integer('turn_id')
            .notNull()
            .references(() => sessionTurns.id, { onDelete: 'cascade' }),
        attempt_index: integer('attempt_index').notNull(),
        max_retries: integer('max_retries').notNull().default(0),
        status: text('status', {
            enum: ['pending', 'streaming', 'completed', 'failed', 'cancelled'],
        })
            .notNull()
            .default('pending'),
        checkpoint_json: text('checkpoint_json').notNull(),
        error_message: text('error_message'),
        duration_ms: integer('duration_ms'),
        started_at: text('started_at')
            .notNull()
            .default(sql`(datetime('now'))`),
        finished_at: text('finished_at'),
        created_at: text('created_at')
            .notNull()
            .default(sql`(datetime('now'))`),
        updated_at: text('updated_at')
            .notNull()
            .default(sql`(datetime('now'))`),
    },
    (table) => [
        index('session_turn_attempts_turn_id_idx').on(table.turn_id),
        uniqueIndex('session_turn_attempts_turn_attempt_unique').on(
            table.turn_id,
            table.attempt_index
        ),
    ]
);

/**
 * LLM 元数据表
 */
export const llmMetadata = sqliteTable('llm_metadata', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    model_id: text('model_id').notNull().unique(),
    name: text('name').notNull(),
    attachment: integer('attachment').notNull().default(0),
    modalities: text('modalities').notNull(), // JSON string
    open_weights: integer('open_weights').notNull().default(0),
    reasoning: integer('reasoning').notNull().default(0),
    release_date: text('release_date'),
    temperature: integer('temperature').notNull().default(1),
    tool_call: integer('tool_call').notNull().default(0),
    knowledge: text('knowledge'), // JSON string
    limit: text('limit'), // JSON string
    created_at: text('created_at')
        .notNull()
        .default(sql`(datetime('now'))`),
    updated_at: text('updated_at')
        .notNull()
        .default(sql`(datetime('now'))`),
});

/**
 * MCP 服务器表
 */
export const mcpServers = sqliteTable('mcp_servers', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull().unique(),
    transport_type: text('transport_type', { enum: ['stdio', 'sse', 'http'] }).notNull(),
    command: text('command'), // Stdio: 命令
    args: text('args'), // Stdio：参数，JSON数组
    env: text('env'), // Stdio：JSON格式
    cwd: text('cwd'), // Stdio：工作目录
    url: text('url'), // SSE/HTTP: 链接
    headers: text('headers'), // JSON格式
    enabled: integer('enabled').notNull().default(1),
    tool_timeout: integer('tool_timeout').notNull().default(30000), // 毫秒
    version: text('version'),
    last_error: text('last_error'),
    last_connected_at: text('last_connected_at'),
    created_at: text('created_at')
        .notNull()
        .default(sql`(datetime('now'))`),
    updated_at: text('updated_at')
        .notNull()
        .default(sql`(datetime('now'))`),
});

/**
 * MCP 工具表
 */
export const mcpTools = sqliteTable('mcp_tools', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    server_id: integer('server_id')
        .notNull()
        .references(() => mcpServers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    input_schema: text('input_schema').notNull(), // JSON字符串
    enabled: integer('enabled').notNull().default(1),
    created_at: text('created_at')
        .notNull()
        .default(sql`(datetime('now'))`),
    updated_at: text('updated_at')
        .notNull()
        .default(sql`(datetime('now'))`),
});

/**
 * MCP 工具调用日志表
 */
export const mcpToolLogs = sqliteTable('mcp_tool_logs', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    server_id: integer('server_id')
        .notNull()
        .references(() => mcpServers.id, { onDelete: 'cascade' }),
    tool_name: text('tool_name').notNull(),
    tool_call_id: text('tool_call_id').notNull(),
    session_id: integer('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    message_id: integer('message_id').references(() => messages.id, { onDelete: 'set null' }),
    iteration: integer('iteration').notNull().default(1),
    input: text('input').notNull(), // JSON string
    output: text('output'), // JSON string
    status: text('status', { enum: ['pending', 'success', 'error', 'timeout'] })
        .notNull()
        .default('pending'),
    duration_ms: integer('duration_ms'),
    error_message: text('error_message'),
    created_at: text('created_at')
        .notNull()
        .default(sql`(datetime('now'))`),
});

/**
 * 内置工具表
 */
export const builtInTools = sqliteTable('built_in_tools', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    tool_id: text('tool_id').notNull().unique(),
    display_name: text('display_name').notNull(),
    description: text('description'),
    enabled: integer('enabled').notNull().default(1),
    risk_level: text('risk_level', { enum: ['low', 'medium', 'high'] })
        .notNull()
        .default('medium'),
    config_json: text('config_json'),
    last_used_at: text('last_used_at'),
    created_at: text('created_at')
        .notNull()
        .default(sql`(datetime('now'))`),
    updated_at: text('updated_at')
        .notNull()
        .default(sql`(datetime('now'))`),
});

/**
 * 内置工具调用日志表
 */
export const builtInToolLogs = sqliteTable('built_in_tool_logs', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    tool_id: text('tool_id').notNull(),
    tool_call_id: text('tool_call_id').notNull(),
    session_id: integer('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    message_id: integer('message_id').references(() => messages.id, { onDelete: 'set null' }),
    iteration: integer('iteration').notNull().default(1),
    input: text('input').notNull(),
    output: text('output'),
    status: text('status', {
        enum: [
            'pending',
            'awaiting_approval',
            'approved',
            'rejected',
            'success',
            'error',
            'timeout',
            'cancelled',
        ],
    })
        .notNull()
        .default('pending'),
    approval_state: text('approval_state', {
        enum: ['none', 'pending', 'approved', 'rejected'],
    })
        .notNull()
        .default('none'),
    approval_summary: text('approval_summary'),
    duration_ms: integer('duration_ms'),
    error_message: text('error_message'),
    created_at: text('created_at')
        .notNull()
        .default(sql`(datetime('now'))`),
});

/**
 * 快速搜索点击统计表
 */
export const quickSearchClickStats = sqliteTable('quick_search_click_stats', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    query_norm: text('query_norm').notNull(),
    path_norm: text('path_norm').notNull(),
    click_count: integer('click_count').notNull().default(0),
    created_at: text('created_at')
        .notNull()
        .default(sql`(datetime('now'))`),
    updated_at: text('updated_at')
        .notNull()
        .default(sql`(datetime('now'))`),
});

// ==================== 类型别名 ====================

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type SessionUpdate = Partial<NewSession>;

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type MessageUpdate = Partial<NewMessage>;

export type Attachment = typeof attachments.$inferSelect;
export type NewAttachment = typeof attachments.$inferInsert;
export type AttachmentUpdate = Partial<NewAttachment>;

export type MessageAttachment = typeof messageAttachments.$inferSelect;
export type NewMessageAttachment = typeof messageAttachments.$inferInsert;
export type MessageAttachmentUpdate = Partial<NewMessageAttachment>;

export type Setting = typeof settings.$inferSelect;
export type NewSetting = typeof settings.$inferInsert;
export type SettingUpdate = Partial<NewSetting>;

export type Statistic = typeof statistics.$inferSelect;
export type NewStatistic = typeof statistics.$inferInsert;
export type StatisticUpdate = Partial<NewStatistic>;

export type TouchAiMeta = typeof touchaiMeta.$inferSelect;
export type NewTouchAiMeta = typeof touchaiMeta.$inferInsert;
export type TouchAiMetaUpdate = Partial<NewTouchAiMeta>;

export type Provider = typeof providers.$inferSelect;
export type NewProvider = typeof providers.$inferInsert;
export type ProviderUpdate = Partial<NewProvider>;

export type Model = typeof models.$inferSelect;
export type NewModel = typeof models.$inferInsert;
export type ModelUpdate = Partial<NewModel>;

export type SessionTurn = typeof sessionTurns.$inferSelect;
export type NewSessionTurn = typeof sessionTurns.$inferInsert;
export type SessionTurnUpdate = Partial<NewSessionTurn>;

export type SessionTurnAttempt = typeof sessionTurnAttempts.$inferSelect;
export type NewSessionTurnAttempt = typeof sessionTurnAttempts.$inferInsert;
export type SessionTurnAttemptUpdate = Partial<NewSessionTurnAttempt>;

export type LlmMetadata = typeof llmMetadata.$inferSelect;
export type NewLlmMetadata = typeof llmMetadata.$inferInsert;
export type LlmMetadataUpdate = Partial<NewLlmMetadata>;

export type McpServer = typeof mcpServers.$inferSelect;
export type NewMcpServer = typeof mcpServers.$inferInsert;
export type McpServerUpdate = Partial<NewMcpServer>;

export type McpTool = typeof mcpTools.$inferSelect;
export type NewMcpTool = typeof mcpTools.$inferInsert;
export type McpToolUpdate = Partial<NewMcpTool>;

export type McpToolLog = typeof mcpToolLogs.$inferSelect;
export type NewMcpToolLog = typeof mcpToolLogs.$inferInsert;
export type McpToolLogUpdate = Partial<NewMcpToolLog>;

export type BuiltInTool = typeof builtInTools.$inferSelect;
export type NewBuiltInTool = typeof builtInTools.$inferInsert;
export type BuiltInToolUpdate = Partial<NewBuiltInTool>;

export type BuiltInToolLog = typeof builtInToolLogs.$inferSelect;
export type NewBuiltInToolLog = typeof builtInToolLogs.$inferInsert;
export type BuiltInToolLogUpdate = Partial<NewBuiltInToolLog>;

export type QuickSearchClickStat = typeof quickSearchClickStats.$inferSelect;
export type NewQuickSearchClickStat = typeof quickSearchClickStats.$inferInsert;
export type QuickSearchClickStatUpdate = Partial<NewQuickSearchClickStat>;

export type MessageRole = Message['role'];
export type ProviderDriver = Provider['driver'];
export type TurnStatus = SessionTurn['status'];
export type RequestStatus = TurnStatus;
export type TransportType = McpServer['transport_type'];
export type ToolLogStatus = McpToolLog['status'];
export type PersistedToolLogStatus = McpToolLog['status'] | BuiltInToolLog['status'];
