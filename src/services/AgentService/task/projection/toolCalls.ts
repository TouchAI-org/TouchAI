// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * 工具调用状态投影。
 *
 * 负责会话消息中 `ToolCallInfo` 的创建、更新与展示同步，
 * 不持有内部可变状态，全部操作通过参数传入的消息数组完成。
 */

import {
    buildBuiltInToolConversationPresentation,
    resolveBuiltInToolConversationSemantic,
} from '@/services/BuiltInToolService/presentation';
import type { SessionMessage, ToolCallInfo } from '@/types/session';

import type { ToolEvent } from '../../contracts/tooling';

// ────────────────────── 消息结构工具函数 ──────────────────────

export function ensureAssistantToolCalls(message: SessionMessage): ToolCallInfo[] {
    if (!message.toolCalls) {
        message.toolCalls = [];
    }

    return message.toolCalls;
}

export function ensureToolCallPart(message: SessionMessage, callId: string): void {
    const hasPart = message.parts.some(
        (part) => part.type === 'tool_call' && part.callId === callId
    );

    if (!hasPart) {
        message.parts.push({
            id: crypto.randomUUID(),
            type: 'tool_call',
            callId,
        });
    }
}

// ────────────────────── 展示信息解析 ──────────────────────

export function resolveToolDisplayInfo(toolEvent: Extract<ToolEvent, { type: 'call_start' }>) {
    const source = toolEvent.source ?? (toolEvent.serverId ? 'mcp' : 'builtin');
    const namespacedName = toolEvent.namespacedName;
    const match = namespacedName.match(/^mcp__\d+__(.+)$/);
    const serverName =
        source === 'mcp' && toolEvent.serverId ? `Server ${toolEvent.serverId}` : undefined;

    return {
        source,
        sourceLabel:
            toolEvent.sourceLabel ??
            (source === 'builtin'
                ? '内置工具'
                : serverName
                  ? `${serverName} MCP 工具`
                  : 'MCP 工具'),
        displayName: match?.[1] ?? toolEvent.toolName ?? namespacedName,
        serverName,
        serverId: toolEvent.serverId ?? null,
    };
}

export function syncBuiltInToolCallPresentation(toolCall: ToolCallInfo): void {
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

// ────────────────────── 工具调用生命周期 ──────────────────────

export function upsertToolCall(
    message: SessionMessage,
    toolEvent: Extract<ToolEvent, { type: 'call_start' }>
): ToolCallInfo {
    const toolCalls = ensureAssistantToolCalls(message);
    const existingToolCall = toolCalls.find((toolCall) => toolCall.id === toolEvent.callId);
    const display = resolveToolDisplayInfo(toolEvent);

    if (existingToolCall) {
        existingToolCall.name = display.displayName;
        existingToolCall.namespacedName = toolEvent.namespacedName;
        existingToolCall.source = display.source;
        existingToolCall.sourceLabel = display.sourceLabel;
        existingToolCall.serverName = display.serverName;
        existingToolCall.serverId = display.serverId;
        existingToolCall.arguments = toolEvent.arguments;
        existingToolCall.builtinConversationSemantic = toolEvent.builtinConversationSemantic;
        if (existingToolCall.status !== 'awaiting_approval') {
            existingToolCall.status = 'executing';
        }
        syncBuiltInToolCallPresentation(existingToolCall);
        return existingToolCall;
    }

    const toolCall: ToolCallInfo = {
        id: toolEvent.callId,
        name: display.displayName,
        namespacedName: toolEvent.namespacedName,
        source: display.source,
        serverName: display.serverName,
        serverId: display.serverId,
        sourceLabel: display.sourceLabel,
        arguments: toolEvent.arguments,
        builtinConversationSemantic: toolEvent.builtinConversationSemantic,
        status: 'executing',
    };
    syncBuiltInToolCallPresentation(toolCall);
    toolCalls.push(toolCall);
    return toolCall;
}

export function updateToolCallStatus(
    history: SessionMessage[],
    messageId: string,
    callId: string,
    updater: (toolCall: ToolCallInfo) => void
): void {
    const message = history.find((item) => item.id === messageId && item.role === 'assistant');
    const toolCall = message?.toolCalls?.find((item) => item.id === callId);

    if (toolCall) {
        updater(toolCall);
        syncBuiltInToolCallPresentation(toolCall);
    }
}
