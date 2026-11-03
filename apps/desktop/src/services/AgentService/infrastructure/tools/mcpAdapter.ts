// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { createMcpToolLog, updateMcpToolLogByCallId } from '@database/queries';
import { log } from '@services/ObservabilityService';
import { serializeAuditPayload } from '@services/ObservabilityService/redact';

import { tt } from '@/i18n';

import { AiError, AiErrorCode } from '../../contracts/errors';
import type { AttachmentIndex } from '../attachments';
import { mcpManager } from '../mcp';
import type { McpToolOutcome, ToolCallInvocation } from './types';

const formatToolNotFoundError = (toolName: string): string =>
    tt('未找到工具：{toolName}', { toolName });
const formatToolExecutionFailedError = (errorMessage: string): string =>
    tt('工具执行失败：{error}', { error: errorMessage });

/**
 * 执行一次 MCP 工具调用：解析命名空间、发事件、写调用日志、调用并回写结果。
 *
 * 取消能力保持诚实：`signal` 只用于本地等待竞争，MCP 目前没有向远端发送显式
 * 取消的协议，用户主动取消只解除本地等待，不代表远端副作用已经停止。超时是另
 * 一条路径——有效超时随调用下发给原生层，由原生层负责在到点时通知远端取消。
 */
export async function executeMcpTool(invocation: ToolCallInvocation): Promise<McpToolOutcome> {
    const { context, toolArgs, requestedTimeoutMs } = invocation;
    const { toolCall, signal, iteration, sessionId, toolCallMessageId, emitToolEvent } = context;

    const callStartTime = Date.now();
    const mapping = await mcpManager.resolveToolCall(toolCall.name);

    if (!mapping) {
        const errorResult = formatToolNotFoundError(toolCall.name);
        const durationMs = Date.now() - callStartTime;
        emitToolEvent({
            type: 'call_end',
            callId: toolCall.id,
            result: errorResult,
            isError: true,
            durationMs,
            finalStatus: 'error',
        });

        return { result: errorResult, isError: true, toolLogId: null };
    }

    emitToolEvent({
        type: 'call_start',
        callId: toolCall.id,
        toolName: mapping.originalName,
        namespacedName: toolCall.name,
        source: 'mcp',
        startedAt: callStartTime,
        serverId: mapping.serverId,
        arguments: toolArgs,
    });

    let toolLogId: number | null = null;
    try {
        const toolLog = await createMcpToolLog({
            server_id: mapping.serverId,
            tool_name: mapping.originalName,
            tool_call_id: toolCall.id,
            session_id: sessionId,
            message_id: toolCallMessageId,
            iteration,
            input: serializeAuditPayload(toolArgs),
            status: 'pending',
        });
        toolLogId = toolLog.id;
    } catch (error) {
        log.error('[McpToolAdapter] Failed to create MCP tool log:', error);
    }

    let toolResult: { result: string; isError: boolean; attachments?: AttachmentIndex[] };
    let cancellation: AiError | undefined;
    try {
        toolResult = await mcpManager.executeTool(toolCall.name, toolArgs, {
            signal,
            iteration,
            toolCallId: toolCall.id,
            requestedTimeoutMs,
            resolved: {
                serverId: mapping.serverId,
                originalName: mapping.originalName,
                toolTimeout: mapping.toolTimeout,
            },
        });
    } catch (error) {
        if (
            signal?.aborted ||
            (error instanceof AiError && error.is(AiErrorCode.REQUEST_CANCELLED)) ||
            (error instanceof Error && error.name === 'AbortError')
        ) {
            cancellation = new AiError(AiErrorCode.REQUEST_CANCELLED, undefined, undefined, {
                cause: error,
            });
        }
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (!cancellation) {
            log.error(`[McpToolAdapter] MCP tool execution failed: ${toolCall.name}`, error);
        }
        toolResult = {
            result: formatToolExecutionFailedError(errorMessage),
            isError: true,
        };
    }

    if (signal?.aborted) cancellation ??= new AiError(AiErrorCode.REQUEST_CANCELLED);

    const durationMs = Date.now() - callStartTime;
    emitToolEvent({
        type: 'call_end',
        callId: toolCall.id,
        result: toolResult.result,
        isError: toolResult.isError,
        durationMs,
        finalStatus: toolResult.isError ? 'error' : 'completed',
    });

    await updateMcpToolLogByCallId(toolCall.id, {
        output: serializeAuditPayload(toolResult.result),
        status: toolResult.isError ? 'error' : 'success',
        duration_ms: durationMs,
        error_message: toolResult.isError ? serializeAuditPayload(toolResult.result) : null,
    }).catch((error) => {
        log.error('[McpToolAdapter] Failed to update MCP tool log:', error);
    });

    if (cancellation) throw cancellation;

    return {
        result: toolResult.result,
        isError: toolResult.isError,
        toolLogId,
        attachments: toolResult.attachments,
    };
}
