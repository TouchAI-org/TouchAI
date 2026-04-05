// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { findAllMcpServers } from '@database/queries/mcpServers';
import type { MessageRow } from '@database/queries/messages';
import type { SessionTurnAttemptHistoryRow } from '@database/queries/sessionTurnAttempts';
import type { SessionTurnHistoryRow } from '@database/queries/sessionTurns';
import type { PersistedToolLogStatus } from '@database/schema';

import { hydratePersistedAttachments } from '@/services/AgentService/infrastructure/attachments';
import {
    buildBuiltInToolConversationPresentation,
    resolveBuiltInToolConversationSemantic,
} from '@/services/BuiltInToolService/presentation';
import {
    SHOW_WIDGET_TOOL_NAME,
    type ShowWidgetPayload,
} from '@/services/BuiltInToolService/tools/widgetTool';
import type { SessionMessage, ToolCallInfo, WidgetInfo } from '@/types/session';
import { parseDbDateTimestamp } from '@/utils/date';
import { createTextPart } from '@/utils/session';
import { normalizeString } from '@/utils/text';

import { getRetryStatusMessage } from '../execution/retry';
import { getSessionData, type SessionData } from './manager';
import {
    ensureAssistantWidgets,
    ensureWidgetPart,
    findWidgetTarget,
    findWidgetTargetByCallId,
    retargetWidgetPart,
    type WidgetTarget,
    type WidgetTargetLookups,
} from './widgets';

interface PersistedHistoryEntry {
    id: number;
    role: MessageRow['role'];
    content: string;
    created_at: string;
    attachments?: Awaited<ReturnType<typeof hydratePersistedAttachments>>;
    toolCalls?: ToolCallInfo[];
    toolResult?: {
        callId: string;
        result: string;
        status: ToolCallInfo['status'];
        durationMs?: number;
        isError?: boolean;
    };
}

interface SessionHistoryBuildResult {
    history: SessionMessage[];
    historyIndexByPersistedMessageId: Map<number, number>;
}

export interface BuildSessionHistoryOptions {
    messages: MessageRow[];
    turns: SessionTurnHistoryRow[];
    attempts: SessionTurnAttemptHistoryRow[];
    resolveServerName: (serverId: number | null) => string;
}

type SessionHistorySourceData = Pick<SessionData, 'messages' | 'turns' | 'attempts'>;

function normalizeDisplayName(namespacedName: string): string {
    const match = namespacedName.match(/^mcp__\d+__(.+)$/);
    if (match?.[1]) {
        return match[1];
    }

    return namespacedName.replace(/^builtin__/, '');
}

function parseToolArguments(raw: string | null): Record<string, unknown> {
    if (!raw) {
        return {};
    }

    try {
        return JSON.parse(raw) as Record<string, unknown>;
    } catch {
        return {};
    }
}

function syncBuiltInToolCallPresentation(toolCall: ToolCallInfo): void {
    if (toolCall.source !== 'builtin') {
        delete toolCall.builtinConversationSemantic;
        delete toolCall.builtinPresentation;
        return;
    }

    if (!toolCall.builtinConversationSemantic && toolCall.result) {
        toolCall.builtinConversationSemantic =
            resolveBuiltInToolConversationSemantic(
                toolCall.namespacedName || toolCall.name,
                toolCall.arguments ?? {},
                {
                    result: toolCall.result,
                }
            ) ?? undefined;
    }
    toolCall.builtinPresentation =
        buildBuiltInToolConversationPresentation(
            toolCall.namespacedName || toolCall.name,
            toolCall.arguments ?? {},
            toolCall.status,
            {
                semantic: toolCall.builtinConversationSemantic,
                result: toolCall.result,
            }
        ) ?? undefined;
}

function isCancellationStatusText(text?: string | null): boolean {
    const normalized = normalizeString(text)?.toLowerCase() ?? '';
    if (!normalized) {
        return false;
    }

    return (
        normalized.includes('取消') ||
        normalized.includes('cancelled by user') ||
        normalized.includes('request cancelled')
    );
}
function assertUnreachablePersistedToolStatus(value: never): never {
    throw new Error(`Unexpected persisted tool status: ${String(value)}`);
}

function mapPersistedToolResultStatus(
    toolStatus: PersistedToolLogStatus | null,
    resultText: string
): ToolCallInfo['status'] {
    if (toolStatus === null) {
        return 'completed';
    }

    switch (toolStatus) {
        case 'rejected':
            return 'rejected';
        case 'awaiting_approval':
            return 'awaiting_approval';
        case 'pending':
        case 'approved':
            return 'executing';
        case 'timeout':
            return 'error';
        case 'error':
            return isCancellationStatusText(resultText) ? 'cancelled' : 'error';
        case 'cancelled':
            return 'cancelled';
        case 'success':
            return 'completed';
    }

    return assertUnreachablePersistedToolStatus(toolStatus);
}

function isPersistedToolResultErrorStatus(
    toolStatus: PersistedToolLogStatus | null,
    resultText: string
): boolean {
    return mapPersistedToolResultStatus(toolStatus, resultText) === 'error';
}

function buildPersistedShowWidgetPayload(toolCall: ToolCallInfo): ShowWidgetPayload | null {
    if (toolCall.namespacedName !== SHOW_WIDGET_TOOL_NAME) {
        return null;
    }

    const mode = toolCall.arguments.mode === 'remove' ? 'remove' : 'render';
    const widgetId =
        normalizeString(toolCall.arguments.widgetId) || (mode === 'render' ? toolCall.id : '');
    if (!widgetId) {
        return null;
    }

    const title = normalizeString(toolCall.arguments.title) || widgetId || 'ShowWidget';
    const description =
        normalizeString(toolCall.arguments.description) ||
        'Inline generative artifact rendered in the answer.';
    const html =
        normalizeString(toolCall.arguments.widget_code) || normalizeString(toolCall.arguments.html);

    if (mode === 'render' && !html) {
        return null;
    }

    return {
        callId: toolCall.id,
        widgetId,
        title,
        description,
        html,
        mode,
        phase: 'ready',
    };
}

/**
 * 数据库里一轮工具调用会被拆成 tool_call / tool_result / assistant 多类消息。
 * 这里先按 message id 聚合，再把工具日志与结果拼回 UI 需要的中间结构。
 *
 * @param rows 已排序的数据库消息行。
 * @param resolveServerName 通过 serverId 解析 MCP 服务器名称。
 * @returns 便于 UI 重组的中间历史结构。
 */
async function buildPersistedEntries(
    rows: MessageRow[],
    resolveServerName: (serverId: number | null) => string
): Promise<PersistedHistoryEntry[]> {
    const entries: PersistedHistoryEntry[] = [];
    let currentEntry: PersistedHistoryEntry | null = null;
    let currentToolCallIds = new Set<string>();

    for (const row of rows) {
        if (!currentEntry || currentEntry.id !== row.id) {
            currentEntry = {
                id: row.id,
                role: row.role,
                content: row.content,
                created_at: row.created_at,
                attachments:
                    row.role === 'user'
                        ? await hydratePersistedAttachments(row.attachments)
                        : undefined,
            };
            entries.push(currentEntry);
            currentToolCallIds = new Set<string>();
        }

        if (
            row.role === 'tool_call' &&
            row.tool_call_id &&
            !currentToolCallIds.has(row.tool_call_id)
        ) {
            currentToolCallIds.add(row.tool_call_id);
            const namespacedName = row.tool_name ?? row.tool_call_id;
            const source = namespacedName.startsWith('builtin__') ? 'builtin' : 'mcp';
            const serverName =
                row.server_id === null ? undefined : resolveServerName(row.server_id);
            const toolCall: ToolCallInfo = {
                id: row.tool_call_id,
                name: normalizeDisplayName(namespacedName),
                namespacedName,
                source,
                serverName,
                serverId: row.server_id,
                sourceLabel: source === 'builtin' ? '内置工具' : serverName || 'MCP 工具',
                arguments: parseToolArguments(row.tool_input),
                status: 'executing',
            };
            syncBuiltInToolCallPresentation(toolCall);
            currentEntry.toolCalls = [...(currentEntry.toolCalls ?? []), toolCall];
        }

        if (row.role === 'tool_result' && row.tool_call_id) {
            const restoredStatus = mapPersistedToolResultStatus(row.tool_status, row.content);
            currentEntry.toolResult = {
                callId: row.tool_call_id,
                result: row.content,
                status: restoredStatus,
                durationMs: row.tool_duration_ms ?? undefined,
                isError: isPersistedToolResultErrorStatus(row.tool_status, row.content),
            };
        }
    }

    return entries;
}

/**
 * 将持久化层拆开的 agent loop 组装为 UI 中的一条 assistant 对话消息。
 *
 * 规则：
 * - `user` 行始终单独保留；
 * - 同一个 `user` 之后直到下一个 `user` 之前的非 user 行，合并成一个 assistant message；
 * - `tool_call` 的文本与最终 assistant 文本都按原始顺序放回 parts；
 * - `tool_result` 不额外渲染，而是回写到对应 toolCall 的执行结果里。
 *
 * @param entries 已聚合的持久化历史记录。
 * @returns UI 可直接消费的对话历史。
 */
function convertEntriesToSessionHistory(
    entries: PersistedHistoryEntry[]
): SessionHistoryBuildResult {
    const history: SessionMessage[] = [];
    const historyIndexByPersistedMessageId = new Map<number, number>();
    let activeAssistantMessage: SessionMessage | null = null;
    let activeAssistantEntryIds: number[] = [];
    let toolCallMap = new Map<string, ToolCallInfo>();
    let pendingToolResultFallbacks: string[] = [];
    const widgetsByCallId = new Map<string, WidgetTarget>();
    const widgetsByWidgetId = new Map<string, WidgetTarget>();
    const widgetLookups: WidgetTargetLookups = {
        widgetsByCallId,
        widgetsByWidgetId,
    };

    const indexPersistedWidget = (message: SessionMessage, widget: WidgetInfo): void => {
        const target = { message, widget };
        widgetsByCallId.set(widget.callId, target);
        widgetsByWidgetId.set(widget.widgetId, target);
    };

    const unindexPersistedWidget = (widget: WidgetInfo): void => {
        const widgetTarget = widgetsByWidgetId.get(widget.widgetId);
        if (widgetTarget?.widget === widget) {
            widgetsByWidgetId.delete(widget.widgetId);
        }

        const callTarget = widgetsByCallId.get(widget.callId);
        if (callTarget?.widget === widget) {
            widgetsByCallId.delete(widget.callId);
        }
    };

    const flushAssistantMessage = () => {
        if (!activeAssistantMessage) {
            return;
        }

        // 历史库里存在一类残缺记录：只落了 tool_result，或 tool_call/tool_result 落库了，
        // 但最终 assistant 文本没有成功持久化。此时如果不把 tool_result 回退成文本，
        // 历史恢复后就只剩首条 prompt，因此只要 assistant 正文为空就把可见结果补回去。
        if (!activeAssistantMessage.content.trim() && pendingToolResultFallbacks.length > 0) {
            const fallbackText = pendingToolResultFallbacks.join('\n\n');
            activeAssistantMessage.content = fallbackText;
            activeAssistantMessage.parts.push(createTextPart(fallbackText));
        }

        const historyIndex = history.length;
        history.push(activeAssistantMessage);
        for (const entryId of activeAssistantEntryIds) {
            historyIndexByPersistedMessageId.set(entryId, historyIndex);
        }
        activeAssistantMessage = null;
        activeAssistantEntryIds = [];
        toolCallMap = new Map<string, ToolCallInfo>();
        pendingToolResultFallbacks = [];
    };

    const ensureAssistantMessage = (entry: PersistedHistoryEntry): SessionMessage => {
        if (!activeAssistantMessage) {
            activeAssistantMessage = {
                id: `assistant-${entry.id}`,
                role: 'assistant',
                content: '',
                parts: [],
                timestamp: parseDbDateTimestamp(entry.created_at),
            };
        }

        if (!activeAssistantEntryIds.includes(entry.id)) {
            activeAssistantEntryIds.push(entry.id);
        }

        return activeAssistantMessage;
    };

    /**
     * ShowWidget 的 artifact 生命周期允许跨轮次更新或移除同一 widget。
     *
     * 历史回放需要按整段会话顺序重放这些变更，因此这里会跨 assistant message
     * 查找已登记的 widget，而不是只看当前消息。
     */
    const upsertPersistedWidget = (
        preferredMessage: SessionMessage,
        payload: ShowWidgetPayload,
        updatedAt: number
    ): WidgetInfo => {
        const preferredMessageId = preferredMessage.id;
        const targetMessage =
            findWidgetTarget(history, payload.widgetId, preferredMessageId, widgetLookups)
                ?.message ??
            findWidgetTargetByCallId(history, payload.callId, preferredMessageId, widgetLookups)
                ?.message ??
            preferredMessage;
        const widgets = ensureAssistantWidgets(targetMessage);
        const existingWidget =
            findWidgetTarget(history, payload.widgetId, targetMessage.id, widgetLookups)?.widget ??
            findWidgetTargetByCallId(history, payload.callId, targetMessage.id, widgetLookups)
                ?.widget;

        if (existingWidget) {
            const previousWidgetId = existingWidget.widgetId;
            unindexPersistedWidget(existingWidget);
            Object.assign(existingWidget, payload, {
                id: payload.widgetId,
                updatedAt,
            });
            retargetWidgetPart(targetMessage, previousWidgetId, payload.widgetId);
            ensureWidgetPart(targetMessage, payload.widgetId);
            indexPersistedWidget(targetMessage, existingWidget);
            return existingWidget;
        }

        const widget: WidgetInfo = {
            id: payload.widgetId,
            ...payload,
            updatedAt,
        };
        widgets.push(widget);
        ensureWidgetPart(targetMessage, payload.widgetId);
        indexPersistedWidget(targetMessage, widget);
        return widget;
    };

    const removePersistedWidgetByWidgetId = (widgetId: string): void => {
        const target = findWidgetTarget(
            history,
            widgetId,
            activeAssistantMessage?.id,
            widgetLookups
        );
        if (!target) {
            return;
        }

        unindexPersistedWidget(target.widget);
        target.message.widgets = target.message.widgets?.filter(
            (widget) => widget.widgetId !== widgetId
        );
        target.message.parts = target.message.parts.filter(
            (part) => !(part.type === 'widget' && part.widgetId === widgetId)
        );
    };

    const removePersistedWidgetByCallId = (callId: string): void => {
        const target = findWidgetTargetByCallId(
            history,
            callId,
            activeAssistantMessage?.id,
            widgetLookups
        );
        if (!target) {
            return;
        }

        const removedWidgetId = target.widget.widgetId;
        unindexPersistedWidget(target.widget);
        target.message.widgets = target.message.widgets?.filter(
            (widget) => widget.callId !== callId
        );
        target.message.parts = target.message.parts.filter(
            (part) => !(part.type === 'widget' && part.widgetId === removedWidgetId)
        );
    };

    for (const entry of entries) {
        if (entry.role === 'user') {
            flushAssistantMessage();
            const historyIndex = history.length;
            history.push({
                id: `user-${entry.id}`,
                role: 'user',
                content: entry.content,
                attachments: entry.attachments?.length ? entry.attachments : undefined,
                parts: [],
                timestamp: parseDbDateTimestamp(entry.created_at),
            });
            historyIndexByPersistedMessageId.set(entry.id, historyIndex);
            continue;
        }

        const assistantMessage = ensureAssistantMessage(entry);

        if ((entry.role === 'assistant' || entry.role === 'tool_call') && entry.content) {
            assistantMessage.content += entry.content;
            assistantMessage.parts.push(createTextPart(entry.content));
        }

        if (entry.role === 'tool_call' && entry.toolCalls?.length) {
            assistantMessage.toolCalls = assistantMessage.toolCalls ?? [];

            for (const toolCall of entry.toolCalls) {
                assistantMessage.toolCalls.push(toolCall);
                if (toolCall.namespacedName !== SHOW_WIDGET_TOOL_NAME) {
                    assistantMessage.parts.push({
                        id: crypto.randomUUID(),
                        type: 'tool_call',
                        callId: toolCall.id,
                    });
                }
                toolCallMap.set(toolCall.id, toolCall);
            }
        }

        if (entry.role === 'tool_result' && entry.toolResult) {
            const toolCall = toolCallMap.get(entry.toolResult.callId);
            if (toolCall) {
                toolCall.result = entry.toolResult.result;
                toolCall.status = entry.toolResult.status;
                toolCall.isError = entry.toolResult.isError;
                toolCall.durationMs = entry.toolResult.durationMs;
                syncBuiltInToolCallPresentation(toolCall);
                if (toolCall.namespacedName === SHOW_WIDGET_TOOL_NAME) {
                    const payload = buildPersistedShowWidgetPayload(toolCall);
                    if (entry.toolResult.isError) {
                        removePersistedWidgetByCallId(toolCall.id);
                    } else if (payload?.mode === 'remove') {
                        removePersistedWidgetByWidgetId(payload.widgetId);
                    } else if (payload?.mode === 'render') {
                        upsertPersistedWidget(
                            assistantMessage,
                            payload,
                            parseDbDateTimestamp(entry.created_at)
                        );
                    }
                }
            } else if (entry.content.trim()) {
                pendingToolResultFallbacks.push(entry.content);
            }
        } else if (entry.role === 'tool_result' && entry.content.trim()) {
            pendingToolResultFallbacks.push(entry.content);
        }
    }

    flushAssistantMessage();
    return {
        history,
        historyIndexByPersistedMessageId,
    };
}

function createDerivedErrorMessage(turn: SessionTurnHistoryRow): SessionMessage {
    const content = `请求失败: ${turn.error_message}`;

    return {
        id: `turn-error-${turn.id}`,
        role: 'assistant',
        content,
        parts: [createTextPart(content)],
        timestamp: parseDbDateTimestamp(turn.updated_at || turn.created_at),
        isError: true,
    };
}

function createDerivedCancelledMessage(turn: SessionTurnHistoryRow): SessionMessage {
    const content = '请求已取消';

    return {
        id: `turn-cancelled-${turn.id}`,
        role: 'assistant',
        content,
        parts: [createTextPart(content)],
        timestamp: parseDbDateTimestamp(turn.updated_at || turn.created_at),
        isCancelled: true,
    };
}

function hasVisibleAssistantContent(message: SessionMessage): boolean {
    if (message.role !== 'assistant') {
        return false;
    }

    if (message.content.trim() || message.reasoning?.trim()) {
        return true;
    }

    return message.parts.some((part) => {
        if (part.type === 'text') {
            return !!part.content.trim();
        }

        return true;
    });
}

function attachStatusText(message: SessionMessage, statusText: string): boolean {
    if (!hasVisibleAssistantContent(message)) {
        return false;
    }

    message.statusText = message.statusText ? `${message.statusText}\n${statusText}` : statusText;
    return true;
}

function markToolCallsCancelled(message: SessionMessage, cancellationText = '请求已取消'): void {
    if (message.role !== 'assistant' || !message.toolCalls?.length) {
        return;
    }

    for (const toolCall of message.toolCalls) {
        if (toolCall.status !== 'executing' && toolCall.status !== 'awaiting_approval') {
            continue;
        }

        toolCall.status = 'cancelled';
        toolCall.isError = false;
        toolCall.result = cancellationText;
        syncBuiltInToolCallPresentation(toolCall);
    }
}

function createDerivedRetryMessage(
    turnId: number,
    attempt: SessionTurnAttemptHistoryRow
): SessionMessage {
    const content = getRetryStatusMessage(attempt.attempt_index, attempt.max_retries);

    return {
        id: `turn-retry-${turnId}-${attempt.attempt_index}`,
        role: 'assistant',
        content,
        parts: [createTextPart(content)],
        timestamp: parseDbDateTimestamp(
            attempt.finished_at || attempt.updated_at || attempt.created_at
        ),
        isRetrying: true,
    };
}

function resolvePromptAnchorIndex(
    turn: SessionTurnHistoryRow,
    historyIndexByPersistedMessageId: Map<number, number>
): number | null {
    if (turn.prompt_message_id !== null) {
        const promptIndex = historyIndexByPersistedMessageId.get(turn.prompt_message_id);
        if (promptIndex !== undefined) {
            return promptIndex;
        }
    }

    return null;
}

function resolveFailedRequestAnchorIndex(
    turn: SessionTurnHistoryRow,
    history: SessionMessage[],
    historyIndexByPersistedMessageId: Map<number, number>
): number {
    if (turn.response_message_id !== null) {
        const responseIndex = historyIndexByPersistedMessageId.get(turn.response_message_id);
        if (responseIndex !== undefined) {
            return responseIndex;
        }
    }

    const promptIndex = resolvePromptAnchorIndex(turn, historyIndexByPersistedMessageId);
    if (promptIndex !== null) {
        const trailingAssistant = history[promptIndex + 1];
        if (trailingAssistant?.role === 'assistant') {
            return promptIndex + 1;
        }

        return promptIndex;
    }

    return history.length - 1;
}

function resolveRetryAnchor(
    turn: SessionTurnHistoryRow,
    history: SessionMessage[],
    historyIndexByPersistedMessageId: Map<number, number>
): { position: 'before' | 'after'; anchorIndex: number } {
    if (turn.response_message_id !== null) {
        const responseIndex = historyIndexByPersistedMessageId.get(turn.response_message_id);
        if (responseIndex !== undefined) {
            return {
                position: 'before',
                anchorIndex: responseIndex,
            };
        }
    }

    const promptIndex = resolvePromptAnchorIndex(turn, historyIndexByPersistedMessageId);
    if (promptIndex !== null) {
        const trailingAssistant = history[promptIndex + 1];
        if (trailingAssistant?.role === 'assistant') {
            return {
                position: 'before',
                anchorIndex: promptIndex + 1,
            };
        }

        return {
            position: 'after',
            anchorIndex: promptIndex,
        };
    }

    return {
        position: 'after',
        anchorIndex: history.length - 1,
    };
}

function pushAnchoredMessage(
    collections: {
        leading: SessionMessage[];
        beforeByIndex: Map<number, SessionMessage[]>;
        afterByIndex: Map<number, SessionMessage[]>;
    },
    message: SessionMessage,
    position: 'before' | 'after',
    anchorIndex: number
): void {
    if (anchorIndex < 0) {
        collections.leading.push(message);
        return;
    }

    const targetCollection =
        position === 'before' ? collections.beforeByIndex : collections.afterByIndex;
    const anchoredMessages = targetCollection.get(anchorIndex) ?? [];
    anchoredMessages.push(message);
    targetCollection.set(anchorIndex, anchoredMessages);
}

function injectDerivedRequestStatuses(
    buildResult: SessionHistoryBuildResult,
    turns: SessionTurnHistoryRow[],
    attempts: SessionTurnAttemptHistoryRow[]
): SessionMessage[] {
    const attemptsByTurnId = new Map<number, SessionTurnAttemptHistoryRow[]>();
    for (const attempt of attempts) {
        const currentAttempts = attemptsByTurnId.get(attempt.turn_id) ?? [];
        currentAttempts.push(attempt);
        attemptsByTurnId.set(attempt.turn_id, currentAttempts);
    }

    const turnsWithDerivedStatuses = turns.filter((turn) => {
        const turnAttempts = attemptsByTurnId.get(turn.id) ?? [];
        return (
            turnAttempts.length > 1 ||
            (turn.status === 'failed' && !!turn.error_message?.trim()) ||
            turn.status === 'cancelled'
        );
    });

    if (turnsWithDerivedStatuses.length === 0) {
        return buildResult.history;
    }

    const collections = {
        leading: [] as SessionMessage[],
        beforeByIndex: new Map<number, SessionMessage[]>(),
        afterByIndex: new Map<number, SessionMessage[]>(),
    };

    for (const turn of turnsWithDerivedStatuses) {
        const turnAttempts = attemptsByTurnId.get(turn.id) ?? [];
        const retryAnchor = resolveRetryAnchor(
            turn,
            buildResult.history,
            buildResult.historyIndexByPersistedMessageId
        );
        turnAttempts.slice(0, -1).forEach((attempt) => {
            pushAnchoredMessage(
                collections,
                createDerivedRetryMessage(turn.id, attempt),
                retryAnchor.position,
                retryAnchor.anchorIndex
            );
        });

        if (turn.status === 'failed' && turn.error_message?.trim()) {
            const anchorIndex = resolveFailedRequestAnchorIndex(
                turn,
                buildResult.history,
                buildResult.historyIndexByPersistedMessageId
            );
            const anchorMessage = buildResult.history[anchorIndex];
            if (
                anchorMessage &&
                attachStatusText(anchorMessage, `请求失败: ${turn.error_message}`)
            ) {
                continue;
            }

            pushAnchoredMessage(collections, createDerivedErrorMessage(turn), 'after', anchorIndex);
        }

        if (turn.status === 'cancelled') {
            const anchorIndex = resolveFailedRequestAnchorIndex(
                turn,
                buildResult.history,
                buildResult.historyIndexByPersistedMessageId
            );
            const anchorMessage = buildResult.history[anchorIndex];
            if (anchorMessage) {
                markToolCallsCancelled(anchorMessage);
            }
            if (anchorMessage && attachStatusText(anchorMessage, '请求已取消')) {
                continue;
            }

            pushAnchoredMessage(
                collections,
                createDerivedCancelledMessage(turn),
                'after',
                anchorIndex
            );
        }
    }

    const history: SessionMessage[] = [...collections.leading];
    buildResult.history.forEach((message, index) => {
        const beforeMessages = collections.beforeByIndex.get(index);
        if (beforeMessages?.length) {
            history.push(...beforeMessages);
        }

        history.push(message);

        const afterMessages = collections.afterByIndex.get(index);
        if (afterMessages?.length) {
            history.push(...afterMessages);
        }
    });

    return history;
}

/**
 * 将持久化消息行恢复成 SearchView 可直接消费的对话历史。
 *
 * @param options 构建选项
 * @param options.messages 已排序的数据库消息行
 * @param options.turns 会话轮次历史
 * @param options.attempts 会话轮次尝试历史
 * @param options.resolveServerName 通过 serverId 解析 MCP 服务器名称
 * @returns 重建后的对话历史
 */
export async function buildSessionHistory(
    options: BuildSessionHistoryOptions
): Promise<SessionMessage[]> {
    const { messages, turns, attempts, resolveServerName } = options;
    return injectDerivedRequestStatuses(
        convertEntriesToSessionHistory(await buildPersistedEntries(messages, resolveServerName)),
        turns,
        attempts
    );
}

/**
 * 基于会话数据构建带服务器名称解析的展示历史。
 */
export async function buildSessionHistoryFromData(
    data: SessionHistorySourceData
): Promise<SessionMessage[]> {
    const servers = await findAllMcpServers();
    const serverNameById = new Map(servers.map((server) => [server.id, server.name]));

    return buildSessionHistory({
        messages: data.messages,
        turns: data.turns,
        attempts: data.attempts,
        resolveServerName: (serverId) => {
            if (serverId === null) {
                return '';
            }

            return serverNameById.get(serverId) ?? `MCP 服务器 ${serverId}`;
        },
    });
}

/**
 * 按会话主键直接加载页面历史。
 */
export async function loadSessionHistory(sessionId: number): Promise<SessionMessage[]> {
    const { messages, turns, attempts } = await getSessionData(sessionId);
    return buildSessionHistoryFromData({
        messages,
        turns,
        attempts,
    });
}
