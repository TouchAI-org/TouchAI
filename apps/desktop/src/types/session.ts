// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type { JSONContent } from '@tiptap/core';

import type { ToolExecutionSource as AiToolExecutionSource } from '@/services/AgentService/contracts/tooling';
import type { Index } from '@/services/AgentService/infrastructure/attachments';
import type {
    BuiltInToolConversationPresentation,
    BuiltInToolConversationSemantic,
} from '@/services/BuiltInToolService';
import type { ShowWidgetPayload } from '@/services/BuiltInToolService/tools/widgetTool';
import type { UserMessageDesktopContext } from '@/services/DesktopContextService/types';

/**
 * SearchView 与 agent 运行时共享的会话展示模型。
 */
export type ToolExecutionSource = AiToolExecutionSource;

/**
 * 工具调用状态常量。
 */
export const ToolCallStatus = {
    EXECUTING: 'executing',
    AWAITING_APPROVAL: 'awaiting_approval',
    COMPLETED: 'completed',
    ERROR: 'error',
    REJECTED: 'rejected',
    CANCELLED: 'cancelled',
} as const;

export type ToolCallStatus = (typeof ToolCallStatus)[keyof typeof ToolCallStatus];

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
    status: ToolCallStatus;
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

export type SessionPart =
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
    status: 'pending' | 'rejected' | 'cancelled';
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

export interface InputHistorySnapshot {
    text: string;
    attachments: Index[];
    editorDoc?: JSONContent;
    excludeFromHistory?: boolean;
}

function cloneJsonContent<T>(value: T): T {
    if (typeof structuredClone === 'function') {
        try {
            return structuredClone(value);
        } catch {
            // 回退到 JSON 克隆，兼容可序列化的响应式对象。
        }
    }

    return JSON.parse(JSON.stringify(value)) as T;
}

function isValidInputHistoryAttachment(attachment: Index | null | undefined): attachment is Index {
    return Boolean(
        attachment &&
        typeof attachment.id === 'string' &&
        (attachment.type === 'image' || attachment.type === 'file') &&
        typeof attachment.path === 'string' &&
        typeof attachment.originPath === 'string' &&
        typeof attachment.name === 'string'
    );
}

export function cloneInputHistorySnapshot(
    snapshot: InputHistorySnapshot | null | undefined
): InputHistorySnapshot | null {
    if (!snapshot) {
        return null;
    }

    const attachments = snapshot.attachments
        .filter(isValidInputHistoryAttachment)
        .map((attachment) => ({ ...attachment }));

    return {
        text: snapshot.text,
        attachments,
        ...(snapshot.editorDoc ? { editorDoc: cloneJsonContent(snapshot.editorDoc) } : {}),
        ...(snapshot.excludeFromHistory ? { excludeFromHistory: true } : {}),
    };
}

export function createInputHistorySnapshot(input: {
    text: string;
    attachments?: Index[] | null;
    editorDoc?: JSONContent | null;
    excludeFromHistory?: boolean;
}): InputHistorySnapshot {
    return (
        cloneInputHistorySnapshot({
            text: input.text,
            attachments: input.attachments ?? [],
            ...(input.editorDoc ? { editorDoc: input.editorDoc } : {}),
            ...(input.excludeFromHistory ? { excludeFromHistory: true } : {}),
        }) ?? {
            text: input.text,
            attachments: [],
            ...(input.excludeFromHistory ? { excludeFromHistory: true } : {}),
        }
    );
}

export function hasInputHistorySnapshotContent(snapshot: InputHistorySnapshot): boolean {
    return snapshot.text.trim().length > 0 || snapshot.attachments.length > 0;
}

export function getInputHistorySnapshotKey(snapshot: InputHistorySnapshot): string {
    return JSON.stringify({
        text: snapshot.text,
        excludeFromHistory: snapshot.excludeFromHistory === true,
        attachments: snapshot.attachments.map((attachment) => ({
            id: attachment.id,
            attachmentId: attachment.attachmentId ?? null,
            hash: attachment.hash ?? null,
            type: attachment.type,
            path: attachment.path,
            originPath: attachment.originPath,
            name: attachment.name,
        })),
    });
}

export interface SessionMessage {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    reasoning?: string;
    /**
     * 当同一轮已经有可见回复时，取消/失败等收尾状态应挂在当前 assistant 消息上，
     * 而不是额外拆成一条新的 assistant turn。
     */
    statusText?: string;
    attachments?: Index[];
    inputSnapshot?: InputHistorySnapshot;
    desktopContext?: UserMessageDesktopContext;
    toolCalls?: ToolCallInfo[];
    approvals?: ToolApprovalInfo[];
    widgets?: WidgetInfo[];
    parts: SessionPart[];
    timestamp: number;
    isStreaming?: boolean;
    isCancelled?: boolean;
    isError?: boolean;
    isRetrying?: boolean;
}

export interface LoadedSessionInfo {
    sessionId: number;
    title: string;
    modelId: string | null;
    providerId: number | null;
}
