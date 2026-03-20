// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type { MessageRow } from '@database/queries/messages';
import type { AiRequest } from '@database/schema';
import { aiService } from '@services/AiService';
import { hydratePersistedAttachments, type Index } from '@services/AiService/attachments';
import { AiError, AiErrorCode } from '@services/AiService/errors';
import {
    createSession,
    getSessionConversation,
    type SessionConversationData,
} from '@services/AiService/session';
import { sendNotification } from '@tauri-apps/plugin-notification';
import { computed, ref } from 'vue';

import { useMcpStore } from '@/stores/mcp';
import { parseDbDateTimestamp } from '@/utils/date';

export interface ToolCallInfo {
    id: string;
    name: string; // 显示名称（不含命名空间前缀）
    namespacedName: string; // 历史恢复时可能只能还原到原始工具名
    serverName: string; // 从命名空间提取的 MCP 服务器名称
    serverId: number; // MCP 服务器 ID
    arguments: Record<string, unknown>;
    result?: string;
    isError?: boolean;
    status: 'executing' | 'completed' | 'error';
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

export type ConversationPart = TextMessagePart | ToolCallMessagePart;

export interface ConversationMessage {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    reasoning?: string;
    attachments?: Index[];
    toolCalls?: ToolCallInfo[];
    parts: ConversationPart[];
    timestamp: number;
    isStreaming?: boolean;
    isCancelled?: boolean; // 标记是否为取消的消息
}

export interface LoadedConversationSession {
    sessionId: number;
    title: string;
    modelId: string | null;
    providerId: number | null;
}

export interface UseAiRequestOptions {
    sessionId?: number;
    onChunk?: (content: string) => void;
    onComplete?: (response: string) => void;
    onError?: (error: Error) => void;
}

interface PersistedHistoryEntry {
    id: number;
    role: MessageRow['role'];
    content: string;
    created_at: string;
    attachments?: Index[];
    toolCalls?: ToolCallInfo[];
    toolResult?: {
        callId: string;
        result: string;
        status: ToolCallInfo['status'];
        durationMs?: number;
        isError?: boolean;
    };
}

function createTextPart(content: string): TextMessagePart {
    return {
        id: crypto.randomUUID(),
        type: 'text',
        content,
    };
}

function normalizeDisplayName(namespacedName: string): string {
    const match = namespacedName.match(/^mcp__\d+__(.+)$/);
    return match?.[1] ?? namespacedName;
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
            const toolCall: ToolCallInfo = {
                id: row.tool_call_id,
                name: normalizeDisplayName(namespacedName),
                namespacedName,
                serverName: resolveServerName(row.server_id),
                serverId: row.server_id ?? 0,
                arguments: parseToolArguments(row.tool_input),
                status: 'executing',
            };
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
 * 将持久化层拆开的 agent loop 重新还原成 UI 中的一条 assistant 对话消息。
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
): ConversationMessage[] {
    const history: ConversationMessage[] = [];
    let activeAssistantMessage: ConversationMessage | null = null;
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

        history.push(activeAssistantMessage);
        activeAssistantMessage = null;
        toolCallMap = new Map<string, ToolCallInfo>();
        pendingToolResultFallbacks = [];
    };

    const ensureAssistantMessage = (entry: PersistedHistoryEntry): ConversationMessage => {
        if (activeAssistantMessage) {
            return activeAssistantMessage;
        }

        activeAssistantMessage = {
            id: `assistant-${entry.id}`,
            role: 'assistant',
            content: '',
            parts: [],
            timestamp: parseDbDateTimestamp(entry.created_at),
        };
        return activeAssistantMessage;
    };

    for (const entry of entries) {
        if (entry.role === 'user') {
            flushAssistantMessage();
            history.push({
                id: `user-${entry.id}`,
                role: 'user',
                content: entry.content,
                attachments: entry.attachments?.length ? entry.attachments : undefined,
                parts: [],
                timestamp: parseDbDateTimestamp(entry.created_at),
            });
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
                assistantMessage.parts.push({
                    id: crypto.randomUUID(),
                    type: 'tool_call',
                    callId: toolCall.id,
                });
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
            } else if (entry.content.trim()) {
                pendingToolResultFallbacks.push(entry.content);
            }
        } else if (entry.role === 'tool_result' && entry.content.trim()) {
            pendingToolResultFallbacks.push(entry.content);
        }
    }

    flushAssistantMessage();
    return history;
}

/**
 * 负责 AI 请求前端交互和状态管理：
 * - 控制加载态、错误态、响应内容
 * - 发起业务请求到 AiService
 * - 转发 UI 层回调
 * - 管理会话历史和历史会话恢复
 *
 * @param options UI 层回调和初始会话配置。
 * @returns AI 请求状态与会话操作方法。
 */
export function useAgent(options: UseAiRequestOptions = {}) {
    const isLoading = ref(false);
    const error = ref<Error | null>(null);
    const response = ref('');
    const reasoning = ref('');
    const currentRequest = ref<AiRequest | null>(null);
    const abortController = ref<AbortController | null>(null);
    let requestId = 0;
    const mcpStore = useMcpStore();

    // 会话数据
    const currentSessionId = ref<number | null>(options.sessionId ?? null);
    const conversationHistory = ref<ConversationMessage[]>([]);

    const hasError = computed(() => error.value !== null);
    const hasResponse = computed(() => response.value.length > 0);

    const toError = (value: unknown): Error => {
        if (value instanceof Error) {
            return value;
        }

        return new Error(String(value));
    };

    const isCancelledError = (requestError: Error): boolean => {
        return requestError instanceof AiError && requestError.is(AiErrorCode.REQUEST_CANCELLED);
    };

    function resetTransientState() {
        response.value = '';
        reasoning.value = '';
        error.value = null;
        currentRequest.value = null;
        abortController.value = null;
    }

    /**
     * 清空 UI 会话历史。
     */
    function clearConversation() {
        conversationHistory.value = [];
        currentSessionId.value = null;
        resetTransientState();
    }

    /**
     * 打开一个已持久化的历史会话，并把数据库消息恢复成 UI 对话结构。
     *
     * @param sessionId 会话主键。
     * @returns 会话基础信息，供上层恢复模型标签。
     */
    async function openSession(sessionId: number): Promise<LoadedConversationSession> {
        if (isLoading.value) {
            throw new Error('当前请求尚未结束，无法切换会话');
        }

        const { session, messages, model }: SessionConversationData =
            await getSessionConversation(sessionId);

        conversationHistory.value = convertEntriesToConversationHistory(
            await buildPersistedEntries(messages, (serverId) =>
                serverId === null ? '' : mcpStore.serverNameById(serverId)
            )
        );
        currentSessionId.value = session.id;
        resetTransientState();

        return {
            sessionId: session.id,
            title: session.title,
            modelId: model?.model_id ?? session.model ?? null,
            providerId: model?.provider_id ?? session.provider_id ?? null,
        };
    }

    /**
     * 触发一次 AI 请求
     */
    async function sendRequest(
        prompt: string,
        attachments: Index[] = [],
        modelId?: string,
        providerId?: number
    ) {
        if (!prompt.trim()) {
            error.value = new Error('Prompt cannot be empty');
            return;
        }

        abortController.value = new AbortController();
        const currentRequestId = ++requestId;

        isLoading.value = true;
        error.value = null;
        response.value = '';
        reasoning.value = '';

        // 添加用户消息到会话历史
        const userMessageId = crypto.randomUUID();
        conversationHistory.value.push({
            id: userMessageId,
            role: 'user',
            content: prompt,
            attachments: attachments.length > 0 ? attachments : undefined,
            parts: [],
            timestamp: Date.now(),
        });

        // 添加 AI 消息占位符，标记为流式传输状态
        const assistantMessageId = crypto.randomUUID();
        conversationHistory.value.push({
            id: assistantMessageId,
            role: 'assistant',
            content: '',
            parts: [],
            timestamp: Date.now(),
            isStreaming: true,
        });

        const assistantMsg = conversationHistory.value[conversationHistory.value.length - 1]!;

        // 如果是新会话，预先创建数据库会话
        if (!currentSessionId.value) {
            try {
                const normalized = prompt.trim().replace(/\s+/g, ' ');
                const title = !normalized
                    ? '新会话'
                    : normalized.length <= 40
                      ? normalized
                      : `${normalized.slice(0, 40)}...`;
                currentSessionId.value = await createSession(
                    title,
                    modelId || '',
                    providerId ?? null
                );
            } catch (sessionError) {
                console.error('[useAiRequest] Failed to pre-create session:', sessionError);
            }
        }

        try {
            const result = await aiService.run({
                prompt,
                sessionId: currentSessionId.value ?? undefined,
                modelId,
                providerId,
                attachments,
                signal: abortController.value.signal,
                onChunk: (chunk) => {
                    if (chunk.reasoning) {
                        reasoning.value += chunk.reasoning;
                        assistantMsg.reasoning = reasoning.value;
                    }

                    if (chunk.content) {
                        response.value += chunk.content;
                        assistantMsg.content = response.value;
                        const lastPart = assistantMsg.parts[assistantMsg.parts.length - 1];
                        if (lastPart && lastPart.type === 'text') {
                            lastPart.content += chunk.content;
                        } else {
                            assistantMsg.parts.push(createTextPart(chunk.content));
                        }

                        options.onChunk?.(chunk.content);
                    }

                    // 处理工具调用事件
                    if (chunk.toolEvent) {
                        if (!assistantMsg.toolCalls) {
                            assistantMsg.toolCalls = [];
                        }

                        const toolEvent = chunk.toolEvent;

                        if (toolEvent.type === 'call_start') {
                            const { namespacedName, serverId } = toolEvent;
                            assistantMsg.toolCalls.push({
                                id: toolEvent.callId,
                                name: normalizeDisplayName(namespacedName),
                                namespacedName,
                                serverName: mcpStore.serverNameById(serverId),
                                serverId,
                                arguments: toolEvent.arguments,
                                status: 'executing',
                            });

                            const hasPart = assistantMsg.parts.some(
                                (part) =>
                                    part.type === 'tool_call' && part.callId === toolEvent.callId
                            );
                            if (!hasPart) {
                                assistantMsg.parts.push({
                                    id: crypto.randomUUID(),
                                    type: 'tool_call',
                                    callId: toolEvent.callId,
                                });
                            }
                        } else if (toolEvent.type === 'call_end') {
                            // 查找并更新匹配的工具调用状态
                            const toolCall = assistantMsg.toolCalls.find(
                                (tc) => tc.id === toolEvent.callId
                            );
                            if (toolCall) {
                                toolCall.result = toolEvent.result;
                                toolCall.isError = toolEvent.isError;
                                toolCall.status = toolEvent.isError ? 'error' : 'completed';
                                toolCall.durationMs = toolEvent.durationMs;
                            }
                        }
                    }
                },
            });

            // 标记 AI 消息为完成状态
            assistantMsg.isStreaming = false;

            currentRequest.value = result.request;
            options.onComplete?.(result.response);
        } catch (rawError) {
            const requestError = toError(rawError);

            if (isCancelledError(requestError)) {
                // 如果是第一次请求就取消（只有用户消息和一个未完成的 AI 消息）
                if (conversationHistory.value.length === 2) {
                    // 清空会话历史
                    conversationHistory.value = [];
                    currentSessionId.value = null;
                } else {
                    if (!assistantMsg.content.trim()) {
                        // 如果没有内容，移除未完成的 AI 消息
                        conversationHistory.value = conversationHistory.value.filter(
                            (msg) => msg.id !== assistantMessageId
                        );
                    } else {
                        // 保留已有内容，停止流式传输
                        assistantMsg.isStreaming = false;
                    }

                    // 追加取消提示
                    conversationHistory.value.push({
                        id: crypto.randomUUID(),
                        role: 'assistant',
                        content: '请求已取消',
                        parts: [],
                        timestamp: Date.now(),
                        isStreaming: false,
                        isCancelled: true,
                    });
                }
                // 取消错误不设置 error.value，避免显示错误提示
                return;
            }

            error.value = requestError;

            // 标记 AI 消息为失败状态（不是取消的情况）
            if (!assistantMsg.isCancelled) {
                assistantMsg.isStreaming = false;
                const failureText = `请求失败: ${requestError.message}`;
                assistantMsg.content = failureText;
                assistantMsg.parts = [createTextPart(failureText)];
            }

            const isEmptyResponse =
                requestError instanceof AiError && requestError.is(AiErrorCode.EMPTY_RESPONSE);

            try {
                sendNotification({
                    title: isEmptyResponse ? 'TouchAI - 空回复' : 'TouchAI - 请求失败',
                    body: requestError.message || '未知错误',
                });
            } catch (notificationError) {
                console.error('[useAiRequest] Failed to send notification:', notificationError);
            }

            options.onError?.(requestError);
        } finally {
            if (currentRequestId === requestId) {
                isLoading.value = false;
            }
        }
    }

    /**
     * 重置 UI 状态。
     */
    function reset() {
        isLoading.value = false;
        resetTransientState();
    }

    /**
     * 取消当前请求并清理 UI 状态。
     */
    function cancel() {
        if (abortController.value) {
            abortController.value.abort();
            reset();
        }
    }

    return {
        isLoading,
        error,
        response,
        reasoning,
        hasError,
        hasResponse,
        sendRequest,
        reset,
        cancel,
        openSession,
        // 会话管理
        currentSessionId,
        conversationHistory,
        clearConversation,
    };
}
