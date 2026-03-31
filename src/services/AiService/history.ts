// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type { MessageRow } from '@database/queries/messages';
import type { SessionTurnAttemptHistoryRow } from '@database/queries/sessionTurnAttempts';
import type { SessionTurnHistoryRow } from '@database/queries/sessionTurns';
import { hydratePersistedAttachments } from '@services/AiService/attachments';
import { getRetryStatusMessage } from '@services/AiService/retry';

import {
    buildBuiltInToolConversationPresentation,
    resolveBuiltInToolConversationSemantic,
} from '@/services/BuiltInToolService/presentation';
import {
    SHOW_WIDGET_TOOL_NAME,
    type ShowWidgetPayload,
} from '@/services/BuiltInToolService/tools/widgetTool';
import type { ConversationMessage, ToolCallInfo, WidgetInfo } from '@/types/conversation';
import { createTextPart } from '@/utils/conversation';
import { parseDbDateTimestamp } from '@/utils/date';
import { normalizeString } from '@/utils/text';

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

interface ConversationHistoryBuildResult {
    history: ConversationMessage[];
    historyIndexByPersistedMessageId: Map<number, number>;
}

export interface BuildConversationHistoryOptions {
    messages: MessageRow[];
    turns: SessionTurnHistoryRow[];
    attempts: SessionTurnAttemptHistoryRow[];
    resolveServerName: (serverId: number | null) => string;
}

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
            currentEntry.toolResult = {
                callId: row.tool_call_id,
                result: row.content,
                status: row.tool_status === 'error' ? 'error' : 'completed',
                durationMs: row.tool_duration_ms ?? undefined,
                isError: row.tool_status === 'error',
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
function convertEntriesToConversationHistory(
    entries: PersistedHistoryEntry[]
): ConversationHistoryBuildResult {
    const history: ConversationMessage[] = [];
    const historyIndexByPersistedMessageId = new Map<number, number>();
    let activeAssistantMessage: ConversationMessage | null = null;
    let activeAssistantEntryIds: number[] = [];
    let toolCallMap = new Map<string, ToolCallInfo>();
    let pendingToolResultFallbacks: string[] = [];

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

    const ensureAssistantMessage = (entry: PersistedHistoryEntry): ConversationMessage => {
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

    const findPersistedWidgetTargetByCallId = (
        callId: string
    ): { message: ConversationMessage; widget: WidgetInfo } | null => {
        if (activeAssistantMessage?.widgets?.length) {
            const activeWidget = activeAssistantMessage.widgets.find(
                (widget) => widget.callId === callId
            );
            if (activeWidget) {
                return {
                    message: activeAssistantMessage,
                    widget: activeWidget,
                };
            }
        }

        for (let index = history.length - 1; index >= 0; index -= 1) {
            const message = history[index];
            if (!message || message.role !== 'assistant' || !message.widgets?.length) {
                continue;
            }

            const widget = message.widgets.find((item) => item.callId === callId);
            if (widget) {
                return { message, widget };
            }
        }

        return null;
    };

    const findPersistedWidgetTarget = (
        widgetId: string
    ): { message: ConversationMessage; widget: WidgetInfo } | null => {
        if (activeAssistantMessage?.widgets?.length) {
            const activeWidget = activeAssistantMessage.widgets.find(
                (widget) => widget.widgetId === widgetId
            );
            if (activeWidget) {
                return {
                    message: activeAssistantMessage,
                    widget: activeWidget,
                };
            }
        }

        for (let index = history.length - 1; index >= 0; index -= 1) {
            const message = history[index];
            if (!message || message.role !== 'assistant' || !message.widgets?.length) {
                continue;
            }

            const widget = message.widgets.find((item) => item.widgetId === widgetId);
            if (widget) {
                return { message, widget };
            }
        }

        return null;
    };

    const ensurePersistedAssistantWidgets = (message: ConversationMessage): WidgetInfo[] => {
        if (!message.widgets) {
            message.widgets = [];
        }

        return message.widgets;
    };

    const ensurePersistedWidgetPart = (message: ConversationMessage, widgetId: string): void => {
        const hasPart = message.parts.some(
            (part) => part.type === 'widget' && part.widgetId === widgetId
        );

        if (!hasPart) {
            message.parts.push({
                id: crypto.randomUUID(),
                type: 'widget',
                widgetId,
            });
        }
    };

    const retargetPersistedWidgetPart = (
        message: ConversationMessage,
        previousWidgetId: string,
        nextWidgetId: string
    ): void => {
        if (previousWidgetId === nextWidgetId) {
            return;
        }

        for (const part of message.parts) {
            if (part.type === 'widget' && part.widgetId === previousWidgetId) {
                part.widgetId = nextWidgetId;
            }
        }
    };

    /**
     * ShowWidget 的 artifact 生命周期允许跨轮次更新或移除同一 widget。
     *
     * 历史回放需要按整段会话顺序重放这些变更，因此这里会跨 assistant message
     * 查找已登记的 widget，而不是只看当前消息。
     */
    const upsertPersistedWidget = (
        preferredMessage: ConversationMessage,
        payload: ShowWidgetPayload,
        updatedAt: number
    ): WidgetInfo => {
        const targetMessage =
            findPersistedWidgetTarget(payload.widgetId)?.message ??
            findPersistedWidgetTargetByCallId(payload.callId)?.message ??
            preferredMessage;
        const widgets = ensurePersistedAssistantWidgets(targetMessage);
        const existingWidget =
            widgets.find((widget) => widget.widgetId === payload.widgetId) ??
            widgets.find((widget) => widget.callId === payload.callId);

        if (existingWidget) {
            const previousWidgetId = existingWidget.widgetId;
            Object.assign(existingWidget, payload, {
                id: payload.widgetId,
                updatedAt,
            });
            retargetPersistedWidgetPart(targetMessage, previousWidgetId, payload.widgetId);
            ensurePersistedWidgetPart(targetMessage, payload.widgetId);
            return existingWidget;
        }

        const widget: WidgetInfo = {
            id: payload.widgetId,
            ...payload,
            updatedAt,
        };
        widgets.push(widget);
        ensurePersistedWidgetPart(targetMessage, payload.widgetId);
        return widget;
    };

    const removePersistedWidgetByWidgetId = (widgetId: string): void => {
        const target = findPersistedWidgetTarget(widgetId);
        if (!target) {
            return;
        }

        target.message.widgets = target.message.widgets?.filter(
            (widget) => widget.widgetId !== widgetId
        );
        target.message.parts = target.message.parts.filter(
            (part) => !(part.type === 'widget' && part.widgetId === widgetId)
        );
    };

    const removePersistedWidgetByCallId = (callId: string): void => {
        const target = findPersistedWidgetTargetByCallId(callId);
        if (!target) {
            return;
        }

        const removedWidgetId = target.widget.widgetId;
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

function createDerivedErrorMessage(turn: SessionTurnHistoryRow): ConversationMessage {
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

function createDerivedRetryMessage(
    turnId: number,
    attempt: SessionTurnAttemptHistoryRow
): ConversationMessage {
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
    history: ConversationMessage[],
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
    history: ConversationMessage[],
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
        leading: ConversationMessage[];
        beforeByIndex: Map<number, ConversationMessage[]>;
        afterByIndex: Map<number, ConversationMessage[]>;
    },
    message: ConversationMessage,
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
    buildResult: ConversationHistoryBuildResult,
    turns: SessionTurnHistoryRow[],
    attempts: SessionTurnAttemptHistoryRow[]
): ConversationMessage[] {
    const attemptsByTurnId = new Map<number, SessionTurnAttemptHistoryRow[]>();
    for (const attempt of attempts) {
        const currentAttempts = attemptsByTurnId.get(attempt.turn_id) ?? [];
        currentAttempts.push(attempt);
        attemptsByTurnId.set(attempt.turn_id, currentAttempts);
    }

    const turnsWithDerivedStatuses = turns.filter((turn) => {
        const turnAttempts = attemptsByTurnId.get(turn.id) ?? [];
        return (
            turnAttempts.length > 1 || (turn.status === 'failed' && !!turn.error_message?.trim())
        );
    });

    if (turnsWithDerivedStatuses.length === 0) {
        return buildResult.history;
    }

    const collections = {
        leading: [] as ConversationMessage[],
        beforeByIndex: new Map<number, ConversationMessage[]>(),
        afterByIndex: new Map<number, ConversationMessage[]>(),
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
            pushAnchoredMessage(
                collections,
                createDerivedErrorMessage(turn),
                'after',
                resolveFailedRequestAnchorIndex(
                    turn,
                    buildResult.history,
                    buildResult.historyIndexByPersistedMessageId
                )
            );
        }
    }

    const history: ConversationMessage[] = [...collections.leading];
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
export async function buildConversationHistory(
    options: BuildConversationHistoryOptions
): Promise<ConversationMessage[]> {
    const { messages, turns, attempts, resolveServerName } = options;
    return injectDerivedRequestStatuses(
        convertEntriesToConversationHistory(
            await buildPersistedEntries(messages, resolveServerName)
        ),
        turns,
        attempts
    );
}
