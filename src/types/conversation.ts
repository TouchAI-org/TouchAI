// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type { Index } from '@services/AiService/attachments';
import type { ToolExecutionSource as AiToolExecutionSource } from '@services/AiService/types';

import type {
    BuiltInToolConversationPresentation,
    BuiltInToolConversationSemantic,
} from '@/services/BuiltInToolService';
import type { ShowWidgetPayload } from '@/services/BuiltInToolService/tools/widgetTool';

/**
 * SearchView 与 agent 运行时共享的会话展示模型。
 */
export type ToolExecutionSource = AiToolExecutionSource;

/**
 * 单次工具调用在会话区的展示模型。
 *
 * `serverName/serverId` 对内置工具可选。
 */
export interface ToolCallInfo {
    id: string;
    name: string;
    namespacedName: string;
    source: ToolExecutionSource;
    serverName?: string;
    serverId?: number | null;
    sourceLabel?: string;
    arguments: Record<string, unknown>;
    builtinConversationSemantic?: BuiltInToolConversationSemantic;
    builtinPresentation?: BuiltInToolConversationPresentation;
    result?: string;
    isError?: boolean;
    status: 'executing' | 'awaiting_approval' | 'completed' | 'error' | 'rejected';
    durationMs?: number;
}

export interface TextMessagePart {
    id: string;
    type: 'text';
    content: string;
}

export interface ToolCallMessagePart {
    id: string;
    type: 'tool_call';
    callId: string;
}

export interface ApprovalMessagePart {
    id: string;
    type: 'approval';
    callId: string;
}

export interface WidgetMessagePart {
    id: string;
    type: 'widget';
    widgetId: string;
}

export type ConversationPart =
    | TextMessagePart
    | ToolCallMessagePart
    | ApprovalMessagePart
    | WidgetMessagePart;

/**
 * 会话区里真正被渲染出来的 widget 实体。
 *
 * `show_widget` 只是生成/更新它的工具动作；UI 与持久化层统一只关心 widget 本身。
 */
export interface WidgetInfo extends ShowWidgetPayload {
    id: string;
    updatedAt: number;
}

/**
 * 会话内审批卡片模型。
 */
export interface ToolApprovalInfo {
    id: string;
    callId: string;
    status: 'pending' | 'rejected';
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
    keyboardApproveAt: number;
    resolutionText?: string;
}

/**
 * 当前等待用户决策的审批上下文。
 *
 * SearchView 键盘层会消费它，把 Enter/Esc 改造成审批快捷键。
 */
export interface PendingToolApproval {
    callId: string;
    messageId: string;
    title: string;
    description: string;
    command: string;
    riskLabel: string;
    reason: string;
    approveLabel: string;
    rejectLabel: string;
    enterHint: string;
    escHint: string;
    keyboardApproveAt: number;
}

export interface ConversationMessage {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    reasoning?: string;
    attachments?: Index[];
    toolCalls?: ToolCallInfo[];
    approvals?: ToolApprovalInfo[];
    widgets?: WidgetInfo[];
    parts: ConversationPart[];
    timestamp: number;
    isStreaming?: boolean;
    isCancelled?: boolean;
    isError?: boolean;
    isRetrying?: boolean;
}

export interface LoadedConversationSession {
    sessionId: number;
    title: string;
    modelId: string | null;
    providerId: number | null;
}
