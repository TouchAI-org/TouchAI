/*
 * Copyright (c) 2026. Qian Cheng. Licensed under GPL v3
 */

import type { DatabaseOperation } from '@services/NativeService/database';

type Row = Record<string, unknown>;
type TelemetryFn = (...args: unknown[]) => unknown;

export interface PersistenceDatabaseTelemetry {
    createMessage: TelemetryFn;
    createSession: TelemetryFn;
    createSessionTurn: TelemetryFn;
    createSessionTurnAttempt: TelemetryFn;
    updateMessage: TelemetryFn;
    syncOutputParts: TelemetryFn;
    updateSession: TelemetryFn;
    updateSessionTurn: TelemetryFn;
    updateSessionTurnAttempt: TelemetryFn;
    updateSessionTurnUsage: TelemetryFn;
    updateSessionTurnAttemptUsage: TelemetryFn;
    refreshSessionMetadata: TelemetryFn;
    findAllMcpTools: TelemetryFn;
    findAllBuiltInTools: TelemetryFn;
    findToolCallPartByCallId: TelemetryFn;
    mergeMessagePartData: TelemetryFn;
    createMessageAttachment: TelemetryFn;
    insertLlmCallParts: TelemetryFn;
}

function asRow(value: unknown): Row {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Expected database row');
    }
    return value as Row;
}

function idOf(value: unknown): number {
    const id = asRow(value).id;
    if (typeof id !== 'number') {
        throw new Error('Expected database row id');
    }
    return id;
}

function outputRows(parts: Row[], messageId: number): Row[] {
    return parts.map((part, sortOrder) => {
        const result: Row = {
            message_id: messageId,
            type: part.type,
            content: part.content,
            started_at: part.startedAt ?? null,
            ended_at: part.endedAt ?? null,
            sort_order: sortOrder,
        };
        if (part.data !== undefined) {
            result.data = part.data;
        }
        return result;
    });
}

function attemptUsagePatch(summary: Row | null): Row {
    return {
        input_tokens: summary?.inputTokens ?? 0,
        output_tokens: summary?.outputTokens ?? 0,
        cache_read_tokens: summary?.cacheReadTokens ?? 0,
        cache_write_tokens: summary?.cacheWriteTokens ?? 0,
        reasoning_tokens: summary?.reasoningTokens ?? 0,
        total_cost_micros: summary?.totalCostMicros ?? 0,
        unpriced_calls: summary?.unpricedCalls ?? 0,
        ttft_ms: summary?.ttftMs ?? null,
        llm_call_count: summary?.llmCallCount ?? 0,
    };
}

function turnUsagePatch(summary: Row | null, behavior: Row | null): Row {
    return {
        ...attemptUsagePatch(summary),
        first_text_ms: behavior?.firstTextMs ?? null,
        tool_call_count: behavior?.toolCallCount ?? 0,
        tool_argument_error_count: behavior?.toolArgumentErrorCount ?? 0,
        model_switch_count: behavior?.modelSwitchCount ?? 0,
        hit_iteration_ceiling: behavior?.hitIterationCeiling ? 1 : 0,
        error_code: behavior?.errorCode ?? null,
        retry_scope: behavior?.retryScope ?? null,
    };
}

export function createPersistenceDatabaseOperation(
    telemetry: PersistenceDatabaseTelemetry
): (request: DatabaseOperation) => Promise<unknown> {
    let turn: Row | null = null;
    let attempt: Row | null = null;

    async function writeOutputMessage(
        sessionId: number,
        role: string,
        messageId: number | null,
        parts: Row[]
    ): Promise<Row> {
        const resolvedMessageId =
            messageId ?? idOf(await telemetry.createMessage({ session_id: sessionId, role }, {}));
        if (messageId !== null) {
            await telemetry.updateMessage(resolvedMessageId, { role }, {});
        }
        if (parts.length > 0) {
            await telemetry.syncOutputParts(
                resolvedMessageId,
                outputRows(parts, resolvedMessageId),
                {}
            );
        }
        await telemetry.refreshSessionMetadata(sessionId, {});
        return { id: resolvedMessageId, session_id: sessionId, role };
    }

    return async function operation(request: DatabaseOperation): Promise<unknown> {
        switch (request.kind) {
            case 'mcp_tool_list':
                return telemetry.findAllMcpTools();
            case 'built_in_tool_list':
                return telemetry.findAllBuiltInTools();
            case 'attachment_ensure':
                return { id: request.input.attachmentId ?? 1, ...request.input };
            case 'task_record_start': {
                const result = await recordStart(telemetry, request.input as Row);
                turn = asRow(result.turn);
                attempt = asRow(result.attempt);
                return result;
            }
            case 'task_persist_output_message': {
                const input = request.input as Row;
                const message = await writeOutputMessage(
                    Number(input.sessionId),
                    String(input.role),
                    typeof input.messageId === 'number' ? input.messageId : null,
                    Array.isArray(input.parts) ? (input.parts as Row[]) : []
                );
                if (!input.linkTurn) {
                    return { message, turn: null };
                }
                const turnId = typeof input.turnId === 'number' ? input.turnId : idOf(turn);
                const responseMessageId = idOf(message);
                try {
                    await telemetry.updateSessionTurn({
                        id: turnId,
                        turnPatch: { response_message_id: responseMessageId },
                        database: {},
                    });
                } catch {
                    // Progress writes keep the last readable turn.
                }
                turn = {
                    ...(turn ?? { id: turnId }),
                    response_message_id: responseMessageId,
                };
                return { message, turn };
            }
            case 'task_update_attempt':
                attempt = await updateAttempt(telemetry, request.input as Row, attempt);
                return attempt;
            case 'task_finish': {
                const result = await finish(telemetry, request.input as Row, turn, attempt);
                turn = asRow(result.turn);
                attempt = result.attempt ? asRow(result.attempt) : null;
                return result;
            }
            case 'task_begin_next_attempt': {
                const result = await beginNextAttempt(telemetry, request.input as Row, turn);
                turn = asRow(result.turn);
                attempt = asRow(result.attempt);
                return result;
            }
            case 'task_persist_tool_result':
                return persistToolResult(telemetry, request.input as Row);
            default:
                throw new Error(`Unsupported test database operation: ${request.kind}`);
        }
    };
}

async function recordStart(telemetry: PersistenceDatabaseTelemetry, input: Row): Promise<Row> {
    const sessionId =
        input.sessionId === null || input.sessionId === undefined
            ? idOf(
                  await telemetry.createSession(
                      {
                          title: input.sessionTitle,
                          model: input.modelName,
                          provider_id: input.providerId,
                      },
                      {}
                  )
              )
            : Number(input.sessionId);
    if (input.sessionId !== null && input.sessionId !== undefined) {
        try {
            await telemetry.updateSession({
                id: sessionId,
                sessionPatch: {
                    model: input.modelName,
                    provider_id: input.providerId,
                },
                database: {},
            });
        } catch {
            // Session identity correction is best effort.
        }
    }

    let userMessageId: number | null =
        typeof input.existingUserMessageId === 'number' ? input.existingUserMessageId : null;
    if (userMessageId === null) {
        userMessageId = idOf(
            await telemetry.createMessage({ session_id: sessionId, role: 'user' }, {})
        );
        const attachments = Array.isArray(input.attachments) ? (input.attachments as Row[]) : [];
        for (const attachment of attachments) {
            await telemetry.createMessageAttachment(
                {
                    message_id: userMessageId,
                    attachment_id: attachment.attachmentId,
                    origin_path: attachment.originPath,
                },
                {}
            );
        }
    }

    let createdTurn: Row;
    if (input.existingTurnId === null || input.existingTurnId === undefined) {
        createdTurn = asRow(
            await telemetry.createSessionTurn(
                {
                    session_id: sessionId,
                    model_id: input.modelId,
                    task_id: input.taskId,
                    execution_mode: input.executionMode,
                    prompt_snapshot_json: input.promptSnapshotJson,
                    prompt_message_id: userMessageId,
                    response_message_id: null,
                    status: 'streaming',
                },
                {}
            )
        );
    } else {
        createdTurn = {
            id: input.existingTurnId,
            session_id: sessionId,
            status: 'streaming',
        };
    }

    let createdAttempt: Row;
    if (input.existingAttemptId === null || input.existingAttemptId === undefined) {
        createdAttempt = asRow(
            await telemetry.createSessionTurnAttempt(
                {
                    turn_id: idOf(createdTurn),
                    attempt_index: 1,
                    max_retries: input.maxRetries,
                    status: 'streaming',
                    checkpoint_json: input.checkpointJson,
                    delivery_manifest_json: input.deliveryManifestJson,
                    started_at: input.startedAt,
                    created_at: input.startedAt,
                    updated_at: input.startedAt,
                },
                {}
            )
        );
    } else {
        createdAttempt = {
            id: input.existingAttemptId,
            turn_id: idOf(createdTurn),
            attempt_index: 1,
            status: 'streaming',
        };
    }

    if (input.promptBreakdownJson) {
        await telemetry.updateSessionTurnUsage({
            id: idOf(createdTurn),
            usagePatch: {
                prompt_breakdown_json: input.promptBreakdownJson,
            },
            database: {},
        });
    }

    return {
        session_id: sessionId,
        user_message_id: userMessageId,
        turn: createdTurn,
        attempt: createdAttempt,
    };
}

async function updateAttempt(
    telemetry: PersistenceDatabaseTelemetry,
    input: Row,
    currentAttempt: Row | null
): Promise<Row> {
    const patch: Row = {};
    if (input.checkpointJson != null) {
        patch.checkpoint_json = input.checkpointJson;
    }
    if (input.deliveryManifestJson != null) {
        patch.delivery_manifest_json = input.deliveryManifestJson;
    }
    await telemetry.updateSessionTurnAttempt({
        id: input.attemptId,
        attemptPatch: patch,
        database: {},
    });
    return { ...(currentAttempt ?? { id: input.attemptId }), ...patch };
}

async function finish(
    telemetry: PersistenceDatabaseTelemetry,
    input: Row,
    currentTurn: Row | null,
    currentAttempt: Row | null
): Promise<Row> {
    const parts = Array.isArray(input.parts) ? (input.parts as Row[]) : [];
    const pendingMessageId =
        typeof input.pendingMessageId === 'number' ? input.pendingMessageId : null;
    let assistantMessageId =
        typeof input.assistantMessageId === 'number' ? input.assistantMessageId : pendingMessageId;

    if (input.assistantMessageId == null && (parts.length > 0 || pendingMessageId !== null)) {
        const message = await writeOutputMessage(
            telemetry,
            Number(input.sessionId),
            'assistant',
            pendingMessageId,
            parts
        );
        assistantMessageId = idOf(message);
    }

    let turnId = typeof input.turnId === 'number' ? input.turnId : currentTurn?.id;
    if (typeof turnId !== 'number') {
        const bootstrap = input.turnBootstrap as Row | null | undefined;
        if (!bootstrap) {
            throw new Error('Turn bootstrap is required when no turn exists');
        }
        const createdTurn = asRow(
            await telemetry.createSessionTurn(
                {
                    session_id: input.sessionId,
                    model_id: bootstrap.modelId,
                    task_id: bootstrap.taskId,
                    execution_mode: bootstrap.executionMode,
                    prompt_snapshot_json: bootstrap.promptSnapshotJson,
                    prompt_message_id: bootstrap.promptMessageId ?? null,
                    response_message_id: null,
                    status: 'streaming',
                },
                {}
            )
        );
        turnId = idOf(createdTurn);
    }

    if (input.usage) {
        const usage = input.usage as { calls?: Row[]; summary: Row };
        if (typeof input.attemptId === 'number') {
            await telemetry.updateSessionTurnAttemptUsage({
                id: input.attemptId,
                usagePatch: attemptUsagePatch(usage.summary),
                database: {},
            });
        }
        if (assistantMessageId !== null && usage.calls?.length) {
            await telemetry.insertLlmCallParts(
                assistantMessageId,
                usage.calls.map((call) => JSON.parse(String(call.data))),
                {},
                currentTurn?.id ?? null
            );
        }
    }

    let attemptRow: Row | null = null;
    if (typeof input.attemptId === 'number') {
        await telemetry.updateSessionTurnAttempt({
            id: input.attemptId,
            attemptPatch: {
                status: input.status,
                error_message: input.errorMessage ?? null,
                duration_ms: input.durationMs ?? null,
                finished_at: input.finishedAt,
            },
            database: {},
        });
        attemptRow = {
            ...(currentAttempt ?? { id: input.attemptId }),
            status: input.status,
            error_message: input.errorMessage ?? null,
        };
    }

    const turnPatch: Row = {
        status: input.status,
        error_message: input.errorMessage ?? null,
        response_message_id: assistantMessageId,
        duration_ms: input.durationMs ?? null,
    };
    if (input.status === 'completed') {
        turnPatch.tokens_used = input.tokensUsed ?? null;
    }
    let turnRow: Row;
    try {
        await telemetry.updateSessionTurn({
            id: turnId,
            turnPatch,
            database: {},
        });
        turnRow = { ...(currentTurn ?? { id: turnId }), ...turnPatch };
    } catch {
        turnRow = currentTurn ?? { id: turnId };
    }

    if (input.usage) {
        const usage = input.usage as { summary: Row };
        await telemetry.updateSessionTurnUsage({
            id: turnId,
            usagePatch: turnUsagePatch(usage.summary, (input.behavior as Row | undefined) ?? null),
            database: {},
        });
    }

    return {
        assistant_message_id: assistantMessageId,
        turn: turnRow,
        attempt: attemptRow,
    };
}

async function beginNextAttempt(
    telemetry: PersistenceDatabaseTelemetry,
    input: Row,
    currentTurn: Row | null
): Promise<Row> {
    const usage = input.usage as { calls?: Row[]; summary: Row } | undefined;
    if (usage) {
        await telemetry.updateSessionTurnAttemptUsage({
            id: input.currentAttemptId,
            usagePatch: attemptUsagePatch(usage.summary),
            database: {},
        });
    }
    await telemetry.updateSessionTurnAttempt({
        id: input.currentAttemptId,
        attemptPatch: {
            status: 'failed',
            error_message: input.errorMessage,
            duration_ms: input.durationMs ?? null,
            finished_at: input.finishedAt,
        },
        database: {},
    });
    const attemptRow = asRow(
        await telemetry.createSessionTurnAttempt(
            {
                turn_id: input.turnId,
                attempt_index: input.attemptIndex,
                max_retries: input.maxRetries,
                status: 'streaming',
                checkpoint_json: input.checkpointJson,
                delivery_manifest_json: input.deliveryManifestJson,
                started_at: input.startedAt,
                created_at: input.startedAt,
                updated_at: input.startedAt,
            },
            {}
        )
    );
    try {
        await telemetry.updateSessionTurn({
            id: input.turnId,
            turnPatch: { status: 'streaming', error_message: null },
            database: {},
        });
    } catch {
        // Keep the previous turn readable if the status update fails.
    }
    const turnRow = {
        ...(currentTurn ?? { id: input.turnId }),
        status: 'streaming',
        error_message: null,
    };
    await telemetry.updateSessionTurnUsage({
        id: input.turnId,
        usagePatch: turnUsagePatch(
            usage?.summary ?? null,
            (input.behavior as Row | undefined) ?? null
        ),
        database: {},
    });
    return { attempt: attemptRow, turn: turnRow };
}

async function writeOutputMessage(
    telemetry: PersistenceDatabaseTelemetry,
    sessionId: number,
    role: string,
    messageId: number | null,
    parts: Row[]
): Promise<Row> {
    const resolvedMessageId =
        messageId ?? idOf(await telemetry.createMessage({ session_id: sessionId, role }, {}));
    if (messageId !== null) {
        await telemetry.updateMessage(resolvedMessageId, { role }, {});
    }
    if (parts.length > 0) {
        await telemetry.syncOutputParts(
            resolvedMessageId,
            outputRows(parts, resolvedMessageId),
            {}
        );
    }
    await telemetry.refreshSessionMetadata(sessionId, {});
    return { id: resolvedMessageId, session_id: sessionId, role };
}

async function persistToolResult(
    telemetry: PersistenceDatabaseTelemetry,
    input: Row
): Promise<Row> {
    let partId = typeof input.toolCallPartId === 'number' ? input.toolCallPartId : null;
    if (
        partId === null &&
        typeof input.toolCallId === 'string' &&
        typeof input.toolCallMessageId === 'number'
    ) {
        const found = await telemetry.findToolCallPartByCallId(
            input.toolCallId,
            input.toolCallMessageId
        );
        if (found) {
            partId = idOf(found);
        }
    }
    if (partId === null) {
        return { part: null };
    }
    const merged = await telemetry.mergeMessagePartData(partId, { output: input.result }, {});
    const part = merged ? asRow(merged) : null;
    if (part && Array.isArray(input.attachments)) {
        for (const attachment of input.attachments as Row[]) {
            await telemetry.createMessageAttachment(
                {
                    message_id: part.message_id,
                    attachment_id: attachment.attachmentId,
                    origin_path: attachment.originPath,
                    tool_call_id: part.tool_call_id,
                    tool_kind: part.tool_kind,
                },
                {}
            );
        }
    }
    if (part) {
        await telemetry.refreshSessionMetadata(part.session_id ?? 1, {});
    }
    return { part };
}
