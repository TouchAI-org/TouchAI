// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { sql } from 'drizzle-orm';
import {
    check,
    index,
    integer,
    primaryKey,
    sqliteTable,
    text,
    uniqueIndex,
} from 'drizzle-orm/sqlite-core';

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

export type ToolLogKind = 'mcp' | 'builtin';

/**
 * 统计键枚举
 */
export enum StatisticKey {
    MODEL_METADATA_LAST_UPDATED_AT = 'model_metadata_last_updated_at',
    MODEL_METADATA_LAST_CHECKED_AT = 'model_metadata_last_checked_at',
    MODEL_METADATA_SOURCE_ETAG = 'model_metadata_source_etag',
    USAGE_MAINTENANCE_RUN_AT = 'usage_maintenance_run_at',
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
        status_badge_dismissed_turn_id: integer('status_badge_dismissed_turn_id'),
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
        index('sessions_activity_idx').on(
            sql`coalesce(${table.last_message_at}, ${table.updated_at}) DESC, ${table.id} DESC`
        ),
    ]
);

/**
 * 消息表
 */
export const messages = sqliteTable(
    'messages',
    {
        id: integer('id').primaryKey({ autoIncrement: true }),
        session_id: integer('session_id')
            .notNull()
            .references(() => sessions.id, { onDelete: 'cascade' }),
        role: text('role', {
            enum: ['user', 'assistant', 'system', 'tool_call'],
        }).notNull(),
        created_at: text('created_at')
            .notNull()
            .default(sql`(datetime('now'))`),
        updated_at: text('updated_at')
            .notNull()
            .default(sql`(datetime('now'))`),
    },
    (table) => [index('messages_session_id_id_idx').on(table.session_id, table.id)]
);

/**
 * 消息输出片段表。
 *
 * text、reasoning 与 tool_call 作为同级片段保存，sort_order 保留模型实际输出顺序；
 * reasoning 的墙钟起止时间直接归属于片段本身；
 * tool_call 片段在 data 中保存调用参数与执行结果，是工具状态的唯一真相源。
 */
export const messageParts = sqliteTable(
    'message_parts',
    {
        id: integer('id').primaryKey({ autoIncrement: true }),
        message_id: integer('message_id')
            .notNull()
            .references(() => messages.id, { onDelete: 'cascade' }),
        type: text('type', {
            enum: ['text', 'reasoning', 'tool_call', 'attachment', 'llm_call'],
        }).notNull(),
        content: text('content').notNull(),
        data: text('data').notNull().default('{}'),
        // Read-only projections: data is the only writable source for typed metadata.
        tool_call_id: text('tool_call_id').generatedAlwaysAs(
            sql`CASE WHEN "type" = 'tool_call' THEN json_extract("data", '$.toolCallId') END`,
            { mode: 'virtual' }
        ),
        tool_kind: text('tool_kind', { enum: ['mcp', 'builtin'] }).generatedAlwaysAs(
            sql`CASE WHEN "type" = 'tool_call' THEN json_extract("data", '$.toolKind') END`,
            { mode: 'virtual' }
        ),
        attachment_id: integer('attachment_id')
            .references(() => attachments.id, { onDelete: 'cascade' })
            .generatedAlwaysAs(
                sql`CASE WHEN "type" = 'attachment' THEN json_extract("data", '$.attachmentId') END`,
                { mode: 'virtual' }
            ),
        started_at: integer('started_at'),
        ended_at: integer('ended_at'),
        sort_order: integer('sort_order').notNull(),
        created_at: text('created_at')
            .notNull()
            .default(sql`(datetime('now'))`),
        updated_at: text('updated_at')
            .notNull()
            .default(sql`(datetime('now'))`),
    },
    (table) => [
        index('message_parts_tool_call_idx').on(table.tool_kind, table.tool_call_id),
        index('message_parts_attachment_idx').on(table.attachment_id),
        index('message_parts_llm_call_idx').on(table.type, table.started_at),
        check(
            'message_parts_data_object_check',
            sql`json_valid(${table.data}) AND json_type(${table.data}) = 'object'`
        ),
        check(
            'message_parts_attachment_check',
            sql`${table.type} <> 'attachment' OR (json_type(${table.data}, '$.attachmentId') IS 'integer' AND json_extract(${table.data}, '$.attachmentId') > 0)`
        ),
        uniqueIndex('message_parts_message_id_sort_order_idx').on(
            table.message_id,
            table.sort_order
        ),
    ]
);

/**
 * 附件缓存表
 */
export const attachments = sqliteTable('attachments', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    hash: text('hash').notNull().unique(),
    type: text('type', { enum: ['image', 'file'] }).notNull(),
    original_name: text('original_name').notNull(),
    origin_path: text('origin_path').notNull(),
    mime_type: text('mime_type'),
    size: integer('size'),
    created_at: text('created_at')
        .notNull()
        .default(sql`(datetime('now'))`),
});

/**
 * provider 侧附件远端引用缓存表。
 */
export const attachmentRemoteRefs = sqliteTable(
    'attachment_remote_refs',
    {
        id: integer('id').primaryKey({ autoIncrement: true }),
        attachment_id: integer('attachment_id')
            .notNull()
            .references(() => attachments.id, { onDelete: 'cascade' }),
        provider_id: integer('provider_id')
            .notNull()
            .references(() => providers.id, { onDelete: 'cascade' }),
        transport_kind: text('transport_kind').notNull(),
        remote_ref: text('remote_ref').notNull(),
        mime_type: text('mime_type'),
        expires_at: text('expires_at'),
        last_used_at: text('last_used_at'),
        created_at: text('created_at')
            .notNull()
            .default(sql`(datetime('now'))`),
        updated_at: text('updated_at')
            .notNull()
            .default(sql`(datetime('now'))`),
    },
    (table) => [
        uniqueIndex('attachment_remote_refs_attachment_provider_transport_unique').on(
            table.attachment_id,
            table.provider_id,
            table.transport_kind
        ),
        index('attachment_remote_refs_provider_id_idx').on(table.provider_id),
    ]
);

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
            'openai-compatible',
            'anthropic',
            'anthropic-compatible',
            'google',
            'deepseek',
            'xai',
            'moonshot',
            'alibaba',
            'minimax',
            'zhipu',
            'mimo',
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
    reasoning_options: text('reasoning_options'), // JSON string: ReasoningOption[]
    release_date: text('release_date'),
    temperature: integer('temperature').notNull().default(1),
    tool_call: integer('tool_call').notNull().default(0),
    knowledge: text('knowledge'),
    context_limit: integer('context_limit'),
    output_limit: integer('output_limit'),
    is_custom_metadata: integer('is_custom_metadata').notNull().default(0), // 用户是否自定义了元数据
    // JSON string: UpstreamModelMetadataPatch；上游 /v1/models 声明过的能力，
    // models.dev 同步时用它保持「上游 > 兜底」的优先级。
    upstream_metadata: text('upstream_metadata'),
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

        // ===== 用量聚合 =====
        /** 新鲜输入（不含缓存） */
        input_tokens: integer('input_tokens').notNull().default(0),
        output_tokens: integer('output_tokens').notNull().default(0),
        cache_read_tokens: integer('cache_read_tokens').notNull().default(0),
        cache_write_tokens: integer('cache_write_tokens').notNull().default(0),
        /** 推理 token，是 output_tokens 的子集，不可重复累加 */
        reasoning_tokens: integer('reasoning_tokens').notNull().default(0),
        /** 成本，微元（1e-6 货币单位），整数避免浮点漂移 */
        total_cost_micros: integer('total_cost_micros').notNull().default(0),
        /** 无定价的调用次数，不计入 total_cost_micros */
        unpriced_calls: integer('unpriced_calls').notNull().default(0),
        /** 首字延迟（取本回合第一次调用） */
        ttft_ms: integer('ttft_ms'),
        /** 到第一个正文（排除推理） */
        first_text_ms: integer('first_text_ms'),
        /** LLM 调用次数（= 工具循环轮数） */
        llm_call_count: integer('llm_call_count').notNull().default(0),
        /** 工具调用次数 */
        tool_call_count: integer('tool_call_count').notNull().default(0),
        /** 调用类型：chat | title | classify | ... 为未来非对话调用预留 */
        kind: text('kind').notNull().default('chat'),

        // ===== Agent 行为信号 =====
        /** 模型切换次数。频繁换模型 = 当前模型能力不足 */
        model_switch_count: integer('model_switch_count').notNull().default(0),
        /** 工具参数解析失败次数（量化结构化输出能力） */
        tool_argument_error_count: integer('tool_argument_error_count').notNull().default(0),
        /** 空回复次数（EMPTY_RESPONSE）。明确的模型缺陷信号 */
        empty_response_count: integer('empty_response_count').notNull().default(0),
        /** 是否触达模型切换上限（任务失控信号） */
        hit_iteration_ceiling: integer('hit_iteration_ceiling').notNull().default(0),
        /** 错误码（AiErrorCode 枚举），按错误类型分布分析 */
        error_code: text('error_code'),
        /** 重试范围：restart（重头来）/ checkpoint（从检查点续） */
        retry_scope: text('retry_scope'),

        // ===== 上下文诊断 =====
        /** 各分片字符数快照（JSON），避免查询时重解析 8 段文本 */
        prompt_breakdown_json: text('prompt_breakdown_json'),

        created_at: text('created_at')
            .notNull()
            .default(sql`(datetime('now'))`),
        updated_at: text('updated_at')
            .notNull()
            .default(sql`(datetime('now'))`),
    },
    (table) => [
        index('session_turns_session_id_idx').on(table.session_id),
        index('session_turns_created_at_idx').on(table.created_at),
        index('session_turns_model_created_idx').on(table.model_id, table.created_at),
        index('session_turns_status_created_idx').on(table.status, table.created_at),
        index('session_turns_session_created_idx').on(
            table.session_id,
            table.created_at,
            table.id
        ),
    ]
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
        delivery_manifest_json: text('delivery_manifest_json').notNull(),
        error_message: text('error_message'),
        duration_ms: integer('duration_ms'),

        // ===== 用量聚合（attempt 级）=====
        input_tokens: integer('input_tokens').notNull().default(0),
        output_tokens: integer('output_tokens').notNull().default(0),
        cache_read_tokens: integer('cache_read_tokens').notNull().default(0),
        cache_write_tokens: integer('cache_write_tokens').notNull().default(0),
        reasoning_tokens: integer('reasoning_tokens').notNull().default(0),
        total_cost_micros: integer('total_cost_micros').notNull().default(0),
        unpriced_calls: integer('unpriced_calls').notNull().default(0),
        ttft_ms: integer('ttft_ms'),
        llm_call_count: integer('llm_call_count').notNull().default(0),

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
        index('session_turn_attempts_started_at_idx').on(table.started_at),
    ]
);

/**
 * 用量日聚合表，永久保留（明细按保留策略裁剪）。
 *
 * 用 sum + count 而非 avg：聚合可以再聚合（sum(sum)/sum(count)），
 * 但 avg(avg) 是错的。
 */
export const usageDailyRollups = sqliteTable(
    'usage_daily_rollups',
    {
        day: text('day').notNull(),
        model_name: text('model_name').notNull(),
        provider_name: text('provider_name').notNull(),
        request_count: integer('request_count').notNull().default(0),
        success_count: integer('success_count').notNull().default(0),
        input_tokens: integer('input_tokens').notNull().default(0),
        output_tokens: integer('output_tokens').notNull().default(0),
        cache_read_tokens: integer('cache_read_tokens').notNull().default(0),
        cache_write_tokens: integer('cache_write_tokens').notNull().default(0),
        reasoning_tokens: integer('reasoning_tokens').notNull().default(0),
        total_cost_micros: integer('total_cost_micros').notNull().default(0),
        unpriced_count: integer('unpriced_count').notNull().default(0),
        sum_ttft_ms: integer('sum_ttft_ms').notNull().default(0),
        sum_duration_ms: integer('sum_duration_ms').notNull().default(0),
        ttft_sample_count: integer('ttft_sample_count').notNull().default(0),
    },
    (table) => [
        primaryKey({ columns: [table.day, table.model_name, table.provider_name] }),
        index('usage_daily_rollups_day_idx').on(table.day),
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
    reasoning_options: text('reasoning_options'), // JSON string: ReasoningOption[]
    release_date: text('release_date'),
    temperature: integer('temperature').notNull().default(1),
    tool_call: integer('tool_call').notNull().default(0),
    knowledge: text('knowledge'), // JSON string
    limit: text('limit'), // JSON string

    // ===== 定价（来自 models.dev，每百万 token）=====
    input_cost_per_million: text('input_cost_per_million'),
    output_cost_per_million: text('output_cost_per_million'),
    cache_read_cost_per_million: text('cache_read_cost_per_million'),
    cache_write_cost_per_million: text('cache_write_cost_per_million'),
    /** 推理 token 单价；为空表示与 output 同价 */
    reasoning_cost_per_million: text('reasoning_cost_per_million'),
    cost_currency: text('cost_currency'),
    /**
     * 按上下文长度分级的价格，JSON：`[{ above, input, output, cacheRead, cacheWrite }]`
     *
     * 未分级的模型为 null。分级是「整个请求按请求总输入切档」，
     * 不是对超出部分单独计价。
     */
    cost_tiers: text('cost_tiers'),

    created_at: text('created_at')
        .notNull()
        .default(sql`(datetime('now'))`),
    updated_at: text('updated_at')
        .notNull()
        .default(sql`(datetime('now'))`),
});

/**
 * LLM 元数据别名表
 *
 * 中转站等上游对同一模型存在多种写法（前缀、日期、-thinking 等），
 * 这里维护别名到元数据模型的映射，供运行时同步做精确匹配。
 */
export const llmMetadataAliases = sqliteTable('llm_metadata_aliases', {
    alias: text('alias').primaryKey(),
    model_id: text('model_id').notNull(),
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

/**
 * 快速搜索点击统计表
 */
export const quickSearchClickStats = sqliteTable(
    'quick_search_click_stats',
    {
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
    },
    (table) => [
        uniqueIndex('quick_search_click_stats_query_path_unique').on(
            table.query_norm,
            table.path_norm
        ),
    ]
);

// ==================== 类型别名 ====================

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type SessionUpdate = Partial<NewSession>;

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type MessageUpdate = Partial<NewMessage>;

export type MessagePart = typeof messageParts.$inferSelect;
export type NewMessagePart = typeof messageParts.$inferInsert;
export type MessagePartUpdate = Partial<NewMessagePart>;

export type Attachment = typeof attachments.$inferSelect;
export type NewAttachment = typeof attachments.$inferInsert;
export type AttachmentUpdate = Partial<NewAttachment>;

export type AttachmentRemoteRef = typeof attachmentRemoteRefs.$inferSelect;
export type NewAttachmentRemoteRef = typeof attachmentRemoteRefs.$inferInsert;
export type AttachmentRemoteRefUpdate = Partial<NewAttachmentRemoteRef>;

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

export type UsageDailyRollup = typeof usageDailyRollups.$inferSelect;
export type NewUsageDailyRollup = typeof usageDailyRollups.$inferInsert;

export type LlmMetadata = typeof llmMetadata.$inferSelect;
export type NewLlmMetadata = typeof llmMetadata.$inferInsert;
export type LlmMetadataUpdate = Partial<NewLlmMetadata>;

export type LlmMetadataAlias = typeof llmMetadataAliases.$inferSelect;
export type NewLlmMetadataAlias = typeof llmMetadataAliases.$inferInsert;

export type McpServer = typeof mcpServers.$inferSelect;
export type NewMcpServer = typeof mcpServers.$inferInsert;
export type McpServerUpdate = Partial<NewMcpServer>;

export type McpTool = typeof mcpTools.$inferSelect;
export type NewMcpTool = typeof mcpTools.$inferInsert;
export type McpToolUpdate = Partial<NewMcpTool>;

export type BuiltInTool = typeof builtInTools.$inferSelect;
export type NewBuiltInTool = typeof builtInTools.$inferInsert;
export type BuiltInToolUpdate = Partial<NewBuiltInTool>;

export type QuickSearchClickStat = typeof quickSearchClickStats.$inferSelect;
export type NewQuickSearchClickStat = typeof quickSearchClickStats.$inferInsert;
export type QuickSearchClickStatUpdate = Partial<NewQuickSearchClickStat>;

export type MessageRole = Message['role'];
export type ProviderDriver = Provider['driver'];
export type TurnStatus = SessionTurn['status'];
export type RequestStatus = TurnStatus;
export type TransportType = McpServer['transport_type'];
export type ToolLogStatus = 'pending' | 'success' | 'error' | 'timeout';
export type BuiltInToolLogStatus =
    | ToolLogStatus
    | 'awaiting_approval'
    | 'approved'
    | 'rejected'
    | 'cancelled';
export type BuiltInToolApprovalState = 'none' | 'pending' | 'approved' | 'rejected';
export type PersistedToolLogStatus = ToolLogStatus | BuiltInToolLogStatus;
