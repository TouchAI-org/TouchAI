import { createToolPart, updateToolPart } from '@database/queries/toolParts';
import type { BuiltInToolLogUpdateData } from '@database/types';
import type { AiToolCall } from '@touchai/models/contracts';

import { serializeAuditPayload } from '@/platform/diagnostics/redact';

import type { ToolAudit, ToolInvocationScope, ToolOutcome } from '../contracts';
import type { ToolEventBuiltInConversationSemantic } from '../contracts/events';
import type { ToolReceipt } from '../contracts/host';

export interface ToolAuditOptions {
    taskId: string;
    isCurrent(scope: ToolInvocationScope): boolean;
}

function identity(name: string): {
    kind: 'builtin' | 'mcp';
    toolName: string;
    serverId?: number | null;
    data: Record<string, unknown>;
} {
    if (name.startsWith('builtin__')) {
        const toolName = name.slice('builtin__'.length);
        return { kind: 'builtin', toolName, data: { tool_id: toolName } };
    }
    const match = /^mcp__(\d+)__(.+)$/.exec(name);
    const parsed = match ? Number(match[1]) : NaN;
    const serverId = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
    const toolName = match?.[2] ?? name;
    return {
        kind: 'mcp',
        serverId,
        toolName,
        data: {
            server_id: serverId,
            tool_name: toolName,
            ...(!match ? { requestedName: name } : {}),
        },
    };
}

/** Receipts belong to one task and are released after its committed tool checkpoint. */
export function createToolAudit(options: ToolAuditOptions) {
    const receipts = new Map<string, { receipt: ToolReceipt; admission: string; saved: boolean }>();
    const admissions = new Set<string>();
    let disposed = false;
    const assertCurrent = (scope: ToolInvocationScope) => {
        if (disposed || scope.task?.taskId !== options.taskId || !options.isCurrent(scope)) {
            throw new Error('TOOL_SCOPE_STALE');
        }
        return scope.task;
    };

    return Object.freeze({
        async begin(
            call: AiToolCall,
            args: Record<string, unknown> | string,
            scope: ToolInvocationScope
        ): Promise<ToolAudit> {
            const task = assertCurrent(scope);
            const { sessionId, messageId } = task.historyTarget;
            if (
                !Number.isSafeInteger(sessionId) ||
                sessionId <= 0 ||
                !Number.isSafeInteger(messageId) ||
                messageId <= 0
            ) {
                throw new Error('TOOL_RESULT_TARGET_MISSING');
            }
            const admission = `${task.attemptToken}:${messageId}:${call.id}`;
            if (admissions.has(admission)) throw new Error('TOOL_CALL_DUPLICATE');
            admissions.add(admission);
            const startedAt = Date.now();
            const tool = identity(call.name);
            const input = serializeAuditPayload(args);
            let partId: number;
            try {
                const part = await createToolPart(tool.kind, {
                    ...tool.data,
                    tool_call_id: call.id,
                    session_id: sessionId,
                    message_id: messageId,
                    iteration: scope.iteration,
                    input,
                    status: 'pending',
                });
                if (!Number.isSafeInteger(part.id)) throw new Error('TOOL_AUDIT_TARGET_MISSING');
                partId = part.id;
            } catch (error) {
                admissions.delete(admission);
                throw error;
            }
            assertCurrent(scope);
            const receiptKey = crypto.randomUUID();
            const entry = {
                receipt: {
                    taskId: task.taskId,
                    attemptToken: task.attemptToken,
                    partId,
                    input,
                } as ToolReceipt,
                admission,
                saved: false,
            };
            receipts.set(receiptKey, entry);
            let initialSemantic: ToolEventBuiltInConversationSemantic | undefined;
            let presentedStart = false;
            const presentStart = (semantic?: ToolEventBuiltInConversationSemantic) => {
                if (presentedStart) return;
                presentedStart = true;
                task.present({
                    type: 'call_start',
                    callId: call.id,
                    toolName: tool.toolName,
                    namespacedName: call.name,
                    source: tool.kind,
                    startedAt,
                    serverId: tool.serverId,
                    arguments: typeof args === 'string' ? {} : args,
                    builtinConversationSemantic: semantic,
                });
            };
            const save = async (patch: BuiltInToolLogUpdateData & { requestedName?: string }) => {
                assertCurrent(scope);
                if (!(await updateToolPart(tool.kind, partId, patch)))
                    throw new Error('TOOL_AUDIT_TARGET_MISSING');
                assertCurrent(scope);
            };
            return Object.freeze({
                receiptKey,
                input,
                async started(semantic) {
                    if (tool.kind === 'builtin' && semantic) {
                        await save({ conversation_semantic_json: JSON.stringify(semantic) });
                        initialSemantic = semantic;
                    }
                    presentStart(semantic);
                },
                async approval(approval, approved) {
                    if (tool.kind !== 'builtin') throw new Error('TOOL_APPROVAL_SOURCE_INVALID');
                    await save({
                        status:
                            approved === undefined
                                ? 'awaiting_approval'
                                : approved
                                  ? 'approved'
                                  : 'rejected',
                        approval_state:
                            approved === undefined ? 'pending' : approved ? 'approved' : 'rejected',
                        approval_summary: approval.reason,
                    });
                    if (approved === undefined)
                        task.present({ type: 'approval_required', callId: call.id, ...approval });
                    else task.present({ type: 'approval_resolved', callId: call.id, approved });
                },
                async finish(outcome: ToolOutcome) {
                    if (entry.saved) throw new Error('TOOL_AUDIT_ALREADY_FINISHED');
                    const result = outcome.persistedResult ?? outcome.result;
                    const durationMs = Date.now() - startedAt;
                    const rejected = outcome.failureCode === 'approval_rejected';
                    const cancelled = outcome.failureCode === 'request_cancelled';
                    const semantic = outcome.conversationSemantic ?? initialSemantic;
                    await save({
                        output: serializeAuditPayload(result),
                        ...(outcome.argumentParseFailed ||
                        outcome.failureCode === 'tool_unavailable'
                            ? { requestedName: call.name }
                            : {}),
                        status:
                            tool.kind === 'builtin' && cancelled
                                ? 'cancelled'
                                : tool.kind === 'builtin' && rejected
                                  ? 'rejected'
                                  : outcome.status === 'timeout'
                                    ? 'timeout'
                                    : outcome.isError
                                      ? 'error'
                                      : 'success',
                        duration_ms: durationMs,
                        error_message: outcome.isError
                            ? serializeAuditPayload(outcome.errorMessage ?? result)
                            : null,
                        ...(tool.kind === 'builtin'
                            ? {
                                  conversation_semantic_json: semantic
                                      ? JSON.stringify(semantic)
                                      : null,
                                  structured_payload_json: outcome.structuredPayload
                                      ? JSON.stringify(outcome.structuredPayload)
                                      : null,
                              }
                            : {}),
                    });
                    entry.receipt = Object.freeze({
                        ...entry.receipt,
                        ...(outcome.attachments
                            ? { attachments: structuredClone(outcome.attachments) }
                            : {}),
                    });
                    entry.saved = true;
                    presentStart(semantic);
                    task.present({
                        type: 'call_end',
                        callId: call.id,
                        result,
                        isError: outcome.isError,
                        durationMs,
                        finalStatus: rejected
                            ? 'rejected'
                            : outcome.isError
                              ? 'error'
                              : 'completed',
                        builtinConversationSemantic: semantic,
                        structuredPayload: outcome.structuredPayload,
                    });
                },
            } satisfies ToolAudit);
        },
        receipt(
            key: string | undefined,
            scope: { taskId: string; attemptToken: string }
        ): ToolReceipt | undefined {
            const entry = key ? receipts.get(key) : undefined;
            return !disposed &&
                entry?.saved &&
                entry.receipt.taskId === scope.taskId &&
                entry.receipt.attemptToken === scope.attemptToken
                ? entry.receipt
                : undefined;
        },
        commit() {
            for (const [key, entry] of receipts)
                if (entry.saved) {
                    receipts.delete(key);
                    admissions.delete(entry.admission);
                }
        },
        dispose() {
            disposed = true;
            receipts.clear();
            admissions.clear();
        },
    });
}

export type TaskToolAudit = ReturnType<typeof createToolAudit>;
