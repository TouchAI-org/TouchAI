import type { WebSearchSource } from './sources';

export type { AiToolCall, AiToolCallDelta } from '@touchai/models/contracts';

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
    /**
     * Opaque attempt identity stamped by the runtime when it forwards the request.
     * Used to scope the wait to the current attempt; never persisted.
     */
    attemptToken?: string;
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

export type ConversationSemanticAction =
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

export interface ConversationSemantic {
    action: ConversationSemanticAction;
    target?: string;
}

export interface ConversationPresentation {
    verb: string;
    content?: string;
}

export interface AgentPresentationChunk {
    content: string;
    reasoning?: string;
    reasoningState?: 'start' | 'end';
    textState?: 'start' | 'end';
    done: boolean;
    toolBoundary?: boolean;
    toolEvent?: ToolEvent;
    contextCompaction?: { id: string; state: 'compacting' | 'compacted' | 'failed' };
    userMessageSource?: { messageId?: string; sourceId: number };
}

export interface PresentedTextAppend {
    partId: string;
    offset: number;
    content: string;
}

export interface AgentPresentationTools {
    resolveSemantic(name: string, args: Record<string, unknown>): ConversationSemantic | null;
    presentation(
        name: string,
        args: Record<string, unknown>,
        status:
            | 'executing'
            | 'awaiting_approval'
            | 'completed'
            | 'error'
            | 'rejected'
            | 'cancelled',
        options?: { semantic?: ConversationSemantic }
    ): ConversationPresentation | null;
    widgetToolName: string;
}

export interface AgentPresentationMessages {
    tt(text: string, values?: Record<string, string | number>): string;
    errorText(code: string): string;
    retryText(attempt: number, maxRetries: number): string;
}

export type ShowWidgetMode = 'render' | 'remove';
export type ShowWidgetPhase = 'draft' | 'ready';

/**
 * widget 类工具向前端发出的渲染事件载荷。
 */
export interface WidgetPayload {
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
 * `result` 是给模型读的文本，这里是给 UI 渲染的结构化数据。
 * The provider stream contract never includes these presentation payloads.
 */
export type AgentStructuredPayload =
    | {
          kind: 'web_search_sources';
          query: string;
          provider: string;
          status: 'searching' | 'done';
          sources: WebSearchSource[];
      }
    | {
          action: string;
          effect?: string;
          kind: 'computer_use';
          pid?: number;
          route?: string;
          windowId?: number;
      };

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
          builtinConversationSemantic?: ConversationSemantic;
      }
    | {
          type: 'call_end';
          callId: string;
          result: string;
          isError: boolean;
          durationMs: number;
          finalStatus?: 'completed' | 'error' | 'rejected';
          builtinConversationSemantic?: ConversationSemantic;
          /**
           * 工具产出的结构化载荷（如 WebSearch 的来源列表）。
           *
           * 与 `result` 并行：`result` 是给模型读的文本，这里给 UI 渲染卡片与引用。
           */
          structuredPayload?: AgentStructuredPayload;
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
    | ({ type: 'widget_upsert' } & WidgetPayload)
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
