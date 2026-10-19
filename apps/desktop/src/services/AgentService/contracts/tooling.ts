// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { JsonObject } from './protocol';

/**
 * 暴露给模型的工具定义。
 */
export interface AiToolDefinition {
    name: string;
    description: string;
    input_schema: {
        type: 'object';
        properties: Record<string, unknown>;
        required?: string[];
        [key: string]: unknown;
    };
    /**
     * 模型可通过 `_meta.timeoutMs` 建议超时时，本工具实际生效的上限（毫秒）。
     *
     * 通常来自用户配置（MCP 服务器的 `tool_timeout`、内置工具的超时设置）：
     * 用户配置值既是默认超时，也是模型建议值的硬上限，模型只能收紧。
     * 未设置表示该工具不接受模型建议的超时——不支持该能力，或用户关闭了
     * 超时——此时工具目录不会给它注入 `_meta` 参数。
     *
     * 这是执行层真正的封顶值：必须与工具执行路径（含 Rust 侧硬上限）
     * 一致，否则模型会以为生效、实际被静默截断。
     *
     * 只在本地的工具目录装配阶段消费；该字段本身不会进入发给 provider 的
     * 工具 schema。
     */
    adaptiveTimeoutCeilingMs?: number;
}

/**
 * 模型在一次响应中声明的工具调用。
 */
export interface AiToolCall {
    id: string;
    name: string;
    arguments: string;
    providerOptions?: Record<string, JsonObject>;
}

/**
 * 工具调用参数在流式阶段的增量快照。
 */
export interface AiToolCallDelta {
    index: number;
    callId?: string;
    name?: string;
    argumentsDelta?: string;
    argumentsBuffer: string;
    isComplete?: boolean;
}

export type ToolExecutionSource = 'mcp' | 'builtin';

/**
 * 工具审批卡片需要展示的标准字段。
 */
export interface ToolApprovalRequest {
    title: string;
    description: string;
    command: string;
    riskLabel: string;
    reason: string;
    commandLabel: string;
    approveLabel: string;
    rejectLabel: string;
    enterHint: string;
    escHint: string;
    keyboardApproveDelayMs?: number;
}

/**
 * 用于 requestToolApproval 回调的 payload。
 */
export interface ToolApprovalDecisionRequest extends ToolApprovalRequest {
    callId: string;
}

/**
 * 单个结构化提问选项。
 */
export interface AskUserQuestionOption {
    label: string;
    description?: string;
}

/**
 * LLM 通过 ask_user_question 工具发起的单个结构化提问。
 */
export interface AskUserQuestion {
    question: string;
    header: string;
    multiSelect?: boolean;
    allowOther?: boolean;
    options: AskUserQuestionOption[];
}

/**
 * 单题作答结果，整体取消时上层返回 null。
 */
export interface AskUserAnswer {
    questionIndex: number;
    selectedLabels: string[];
    otherText?: string;
    skipped: boolean;
}

export interface ToolEventModelSummary {
    providerId: number;
    providerName: string;
    modelId: string;
    modelName: string;
}

export type ToolEventBuiltInConversationSemanticAction =
    | 'process'
    | 'run'
    | 'search'
    | 'read'
    | 'review'
    | 'update'
    | 'switch'
    | 'render'
    | 'remove'
    | 'ask'
    | 'cursor';

export interface ToolEventBuiltInConversationSemantic {
    action: ToolEventBuiltInConversationSemanticAction;
    target?: string;
}

export type ShowWidgetMode = 'render' | 'remove';
export type ShowWidgetPhase = 'draft' | 'ready';

/**
 * widget 类工具向前端发出的渲染事件载荷。
 */
export interface ShowWidgetEventPayload {
    callId: string;
    widgetId: string;
    title: string;
    description: string;
    html: string;
    mode: ShowWidgetMode;
    phase: ShowWidgetPhase;
}

/**
 * 工具产出的结构化载荷。
 *
 * 用于把“给模型看的文本”和“给 UI 渲染的结构化数据”分开：
 * 工具结果文本保持向后兼容，结构化部分走单独通道。
 */
export interface ToolEventStructuredPayload {
    kind: 'web_search_sources';
    /** 搜索使用的引擎标识（`deepseek` / `brave` 等）。 */
    provider: string;
    query: string;
    status: 'searching' | 'done';
    sources: Array<{
        id: string;
        index: number;
        title: string;
        url: string;
        snippet?: string;
        siteName?: string;
        favicon?: string;
        publishedAt?: string;
        score?: number;
        authority?: number;
    }>;
}

/**
 * Agent 循环过程中发给 UI 的统一事件。
 */
export type ToolEvent =
    | {
          type: 'call_start';
          callId: string;
          toolName: string;
          namespacedName: string;
          source: ToolExecutionSource;
          startedAt?: number;
          serverId?: number | null;
          sourceLabel?: string;
          arguments: Record<string, unknown>;
          builtinConversationSemantic?: ToolEventBuiltInConversationSemantic;
      }
    | {
          type: 'call_end';
          callId: string;
          result: string;
          isError: boolean;
          durationMs: number;
          finalStatus?: 'completed' | 'error' | 'rejected';
          builtinConversationSemantic?: ToolEventBuiltInConversationSemantic;
          /**
           * 工具产出的结构化载荷（如 WebSearch 的来源列表）。
           *
           * 与 `result` 并行：`result` 是给模型读的文本，这里给 UI 渲染卡片与引用。
           */
          structuredPayload?: ToolEventStructuredPayload;
      }
    | {
          type: 'result_delta';
          callId: string;
          result: string;
      }
    | ({ type: 'approval_required'; callId: string } & ToolApprovalRequest)
    | {
          type: 'approval_resolved';
          callId: string;
          approved: boolean;
          resolutionText?: string;
      }
    | ({ type: 'widget_upsert' } & ShowWidgetEventPayload)
    | {
          type: 'widget_remove';
          callId: string;
          widgetId: string;
      }
    | {
          type: 'model_switched';
          fromModel: ToolEventModelSummary;
          toModel: ToolEventModelSummary;
          restart: boolean;
      }
    | {
          type: 'request_retry';
          attempt: number;
          maxRetries: number;
          reason: string;
          retryScope: 'restart' | 'checkpoint';
          resumeFromIteration: number;
          discardVisibleOutputSinceCheckpoint: boolean;
          discardToolActivitySinceCheckpoint: boolean;
      }
    | { type: 'iteration_start'; iteration: number }
    | { type: 'iteration_end'; iteration: number };
