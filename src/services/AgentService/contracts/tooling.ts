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
    | 'remove';

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
 * Agent 循环过程中发给 UI 的统一事件。
 */
export type ToolEvent =
    | {
          type: 'call_start';
          callId: string;
          toolName: string;
          namespacedName: string;
          source: ToolExecutionSource;
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
      }
    | { type: 'iteration_start'; iteration: number }
    | { type: 'iteration_end'; iteration: number };
