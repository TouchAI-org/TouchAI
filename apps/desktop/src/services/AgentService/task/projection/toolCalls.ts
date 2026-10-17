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
import { createToolCallPart, findToolCallPart, selectToolCalls } from '@/utils/session';

import type { ToolEvent } from '../../contracts/tooling';

// ────────────────────── 消息结构工具函数 ──────────────────────

/** 返回消息内全部工具调用，顺序与片段顺序一致。 */
export function listToolCalls(message: SessionMessage): ToolCallInfo[] {
    return selectToolCalls(message);
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

    if (!toolCall.builtinConversationSemantic) {
        toolCall.builtinConversationSemantic =
            resolveBuiltInToolConversationSemantic(
                toolCall.namespacedName || toolCall.name,
                toolCall.arguments ?? {}
            ) ?? undefined;
    }
    toolCall.builtinPresentation =
        buildBuiltInToolConversationPresentation(
            toolCall.namespacedName || toolCall.name,
            toolCall.arguments ?? {},
            toolCall.status,
            {
                semantic: toolCall.builtinConversationSemantic,
            }
        ) ?? undefined;
}

// ────────────────────── 工具调用生命周期 ──────────────────────

export function upsertToolCall(
    message: SessionMessage,
    toolEvent: Extract<ToolEvent, { type: 'call_start' }>
): ToolCallInfo {
    const display = resolveToolDisplayInfo(toolEvent);
    const existingPart = findToolCallPart(message, toolEvent.callId);

    if (existingPart) {
        const toolCall = existingPart.toolCall;
        toolCall.name = display.displayName;
        toolCall.namespacedName = toolEvent.namespacedName;
        toolCall.source = display.source;
        toolCall.sourceLabel = display.sourceLabel;
        toolCall.serverName = display.serverName;
        toolCall.serverId = display.serverId;
        toolCall.arguments = toolEvent.arguments;
        toolCall.startedAt = toolEvent.startedAt ?? toolCall.startedAt ?? Date.now();
        toolCall.builtinConversationSemantic = toolEvent.builtinConversationSemantic;
        if (toolCall.status !== 'awaiting_approval') {
            toolCall.status = 'executing';
        }
        syncBuiltInToolCallPresentation(toolCall);
        return toolCall;
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
        startedAt: toolEvent.startedAt ?? Date.now(),
    };
    syncBuiltInToolCallPresentation(toolCall);
    message.parts.push(createToolCallPart(toolCall));
    return toolCall;
}

export function updateToolCallStatus(
    history: SessionMessage[],
    messageId: string,
    callId: string,
    updater: (toolCall: ToolCallInfo) => void
): void {
    const message = history.find((item) => item.id === messageId && item.role === 'assistant');
    const toolCall = message ? findToolCallPart(message, callId)?.toolCall : undefined;

    if (toolCall) {
        updater(toolCall);
        syncBuiltInToolCallPresentation(toolCall);
    }
}
