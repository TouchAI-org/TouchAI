// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type {
    AttachmentEntity,
    SessionTurnAttemptEntity,
    SessionTurnEntity,
} from '@database/types';
import { native } from '@services/NativeService';
import type {
    DatabaseAttachmentInput,
    DatabaseAttemptUsageWrite,
    DatabaseOutputPartInput,
    DatabaseTurnBehaviorSignals,
} from '@services/NativeService/database';
import { log } from '@services/ObservabilityService';

import {
    type AttachmentIndex,
    createEmptyAttachmentDeliveryManifest,
    prepareAttachmentForPersistence,
    type PreparedAttachmentForPersistence,
    serializeAttachmentDeliveryManifest,
    upsertAttachmentDeliveryManifestRequest,
} from '@/services/AgentService/infrastructure/attachments';
import {
    buildLlmCallPartData,
    countUnpriced,
    resolveCalls,
    sumCost,
    sumUsage,
} from '@/services/UsageService';
import {
    buildPromptBreakdown,
    type PromptBreakdownJson,
} from '@/services/UsageService/contextBreakdown';
import { toDbTimestamp } from '@/utils/date';

import {
    type AiCallRecord,
    type AttachmentDeliveryManifest,
    type AttachmentDeliveryManifestRequest,
    normalizeOutputParts,
    type PersistedOutputPart,
} from '../contracts/protocol';
import type { AttemptCheckpoint } from '../execution/executor';
import type { PromptSnapshot } from '../prompt/types';
import type { TaskExecutionMode } from '../task/types';

class AttemptState {
    constructor(
        public readonly entity: SessionTurnAttemptEntity,
        public readonly startedAtMs: number
    ) {}

    getDurationMs(): number {
        return Math.max(0, Date.now() - this.startedAtMs);
    }
}

interface PersistenceProjectorModel {
    id: number;
    model_id: string;
    provider_id: number;
}

interface PersistenceProjectorOptions {
    prompt: string;
    attachments?: AttachmentIndex[];
    model: PersistenceProjectorModel;
    sessionId?: number | null;
    taskId: string;
    executionMode: TaskExecutionMode;
    promptSnapshot: PromptSnapshot;
    deliveryManifest?: AttachmentDeliveryManifest;
    maxRetries: number;
    buildSessionTitle: (prompt: string) => string;
}

interface CompleteTurnOptions {
    durationMs: number;
    tokensUsed?: number | null;
    outputParts: PersistedOutputPart[];
    calls?: AiCallRecord[];
    ttftMs?: number | null;
    firstTextMs?: number | null;
    toolArgumentErrors?: number;
    modelSwitchCount?: number;
    hitModelSwitchCeiling?: boolean;
}

interface TerminalUsageOptions {
    calls?: AiCallRecord[];
    ttftMs?: number | null;
    firstTextMs?: number | null;
    toolArgumentErrors?: number;
    modelSwitchCount?: number;
    hitModelSwitchCeiling?: boolean;
    errorCode?: string | null;
    retryScope?: string | null;
}

interface TaskStartResult {
    session_id: number;
    user_message_id: number;
    turn: SessionTurnEntity;
    attempt: SessionTurnAttemptEntity;
}

interface TaskOutputMessageResult {
    message: { id: number };
    turn: SessionTurnEntity | null;
}

interface TaskFinishResult {
    assistant_message_id: number | null;
    turn: SessionTurnEntity;
    attempt: SessionTurnAttemptEntity | null;
}

interface TaskAttemptResult {
    turn: SessionTurnEntity;
    attempt: SessionTurnAttemptEntity;
}

interface TaskToolResult {
    part: Record<string, unknown> | null;
}

interface ResolvedUsage {
    usage: DatabaseAttemptUsageWrite | null;
    toolCallCount: number;
}

function serializeCheckpoint(checkpoint: AttemptCheckpoint): string {
    return JSON.stringify({
        activeModelId: checkpoint.activeModel.id,
        iteration: checkpoint.iteration,
        modelSwitchCount: checkpoint.modelSwitchCount,
        modelLanguageContext: checkpoint.modelLanguageContext,
        executedBuiltInToolIds: checkpoint.executedBuiltInToolIds,
        outputBoundary: {
            textLength: checkpoint.response.length,
            reasoningLength: checkpoint.reasoning.length,
            partCount: checkpoint.outputParts.length,
        },
    });
}

function serializeCurrentDeliveryManifest(manifest: AttachmentDeliveryManifest): string {
    return serializeAttachmentDeliveryManifest(manifest);
}

function toOutputPartInput(part: PersistedOutputPart): DatabaseOutputPartInput {
    return {
        type: part.type,
        content: part.content,
        ...(part.type === 'reasoning' && part.providerOptions
            ? { data: JSON.stringify(part.providerOptions) }
            : {}),
        startedAt: part.type === 'reasoning' ? (part.startedAt ?? null) : null,
        endedAt: part.type === 'reasoning' ? (part.endedAt ?? null) : null,
    };
}

function isAttachmentEntity(
    attachment: AttachmentIndex | AttachmentEntity
): attachment is AttachmentEntity {
    return 'original_name' in attachment;
}

function toAttachmentInput(
    attachment: AttachmentIndex | AttachmentEntity,
    prepared: PreparedAttachmentForPersistence
): DatabaseAttachmentInput {
    if (isAttachmentEntity(attachment)) {
        return {
            attachmentId: attachment.id,
            hash: attachment.hash,
            type: attachment.type,
            originalName: attachment.original_name,
            originPath: attachment.origin_path,
            mimeType: attachment.mime_type,
            size: attachment.size,
        };
    }

    return {
        attachmentId: attachment.attachmentId ?? null,
        hash: attachment.hash ?? prepared.hash,
        type: attachment.type,
        originalName: attachment.name || prepared.name,
        originPath: attachment.originPath,
        mimeType: attachment.mimeType ?? prepared.mimeType,
        size: attachment.size ?? prepared.size,
    };
}

export class PersistenceProjector {
    private readonly prompt: string;
    private readonly attachments: Array<AttachmentIndex | AttachmentEntity>;
    private readonly model: PersistenceProjectorModel;
    private readonly taskId: string;
    private readonly executionMode: TaskExecutionMode;
    private readonly promptSnapshot: PromptSnapshot;
    private deliveryManifest: AttachmentDeliveryManifest;
    private readonly maxRetries: number;
    private readonly buildSessionTitle: (prompt: string) => string;

    private sessionId: number | null;
    private userMessageId: number | null;
    private assistantMessageId: number | null;
    private pendingOutputMessageId: number | null = null;
    private turn: SessionTurnEntity | null;
    private turnStartedAtMs: number | null;
    private attemptState: AttemptState | null;
    private turnStartPromise: Promise<void> | null = null;
    private attemptGeneration = 0;
    private lastProgressStep = -1;

    constructor(options: PersistenceProjectorOptions) {
        this.prompt = options.prompt;
        this.attachments = options.attachments ?? [];
        this.model = options.model;
        this.taskId = options.taskId;
        this.executionMode = options.executionMode;
        this.promptSnapshot = options.promptSnapshot;
        this.deliveryManifest = options.deliveryManifest ?? createEmptyAttachmentDeliveryManifest();
        this.maxRetries = options.maxRetries;
        this.buildSessionTitle = options.buildSessionTitle;

        this.sessionId = options.sessionId ?? null;
        this.userMessageId = null;
        this.assistantMessageId = null;
        this.turn = null;
        this.turnStartedAtMs = null;
        this.attemptState = null;
    }

    getAttemptGeneration(): number {
        return this.attemptGeneration;
    }

    async recordTurnStart(initialCheckpoint: AttemptCheckpoint): Promise<void> {
        if (!this.turnStartPromise) {
            this.turnStartPromise = this.recordTurnStartInternal(initialCheckpoint).finally(() => {
                this.turnStartPromise = null;
            });
        }
        await this.turnStartPromise;
    }

    private async recordTurnStartInternal(initialCheckpoint: AttemptCheckpoint): Promise<void> {
        const now = Date.now();
        const shouldPersistAttachments = !this.userMessageId && this.attachments.length > 0;
        const preparedAttachments = shouldPersistAttachments
            ? await Promise.all(
                  this.attachments.map((attachment) =>
                      isAttachmentEntity(attachment)
                          ? Promise.resolve({
                                hash: attachment.hash,
                                name: attachment.original_name,
                                mimeType: attachment.mime_type,
                                size: attachment.size,
                            })
                          : prepareAttachmentForPersistence(attachment)
                  )
              )
            : [];
        const breakdown = await this.buildPromptBreakdownSnapshot();
        const hadTurn = this.turn !== null;
        const attemptStartedAtMs = this.attemptState?.startedAtMs ?? now;
        const result = await native.database.operation<TaskStartResult>({
            kind: 'task_record_start',
            input: {
                sessionId: this.sessionId,
                sessionTitle: this.buildSessionTitle(this.prompt),
                modelId: this.model.id,
                modelName: this.model.model_id,
                providerId: this.model.provider_id,
                taskId: this.taskId,
                executionMode: this.executionMode,
                prompt: this.prompt,
                promptSnapshotJson: JSON.stringify(this.promptSnapshot),
                promptBreakdownJson: breakdown ? JSON.stringify(breakdown) : null,
                checkpointJson: serializeCheckpoint(initialCheckpoint),
                deliveryManifestJson: serializeCurrentDeliveryManifest(this.deliveryManifest),
                startedAt: toDbTimestamp(new Date(now)),
                maxRetries: this.maxRetries,
                existingUserMessageId: this.userMessageId,
                existingTurnId: this.turn?.id ?? null,
                existingAttemptId: this.attemptState?.entity.id ?? null,
                attachments: shouldPersistAttachments
                    ? this.attachments.map((attachment, index) =>
                          toAttachmentInput(attachment, preparedAttachments[index]!)
                      )
                    : [],
            },
        });

        this.sessionId = result.session_id;
        this.userMessageId = result.user_message_id;
        this.turn = result.turn;
        this.attemptState = new AttemptState(result.attempt, attemptStartedAtMs);
        if (!hadTurn) {
            this.turnStartedAtMs = now;
        }
        this.attemptGeneration += 1;
        this.lastProgressStep = -1;
    }

    private async buildPromptBreakdownSnapshot(): Promise<PromptBreakdownJson | null> {
        try {
            const [mcpTools, builtInTools] = await Promise.all([
                native.database.operation<Record<string, unknown>[]>({
                    kind: 'mcp_tool_list',
                    enabledOnly: false,
                }),
                native.database.operation<Record<string, unknown>[]>({
                    kind: 'built_in_tool_list',
                    enabledOnly: false,
                }),
            ]);
            return buildPromptBreakdown(
                this.promptSnapshot,
                mcpTools as never,
                builtInTools as never
            );
        } catch (error) {
            log.warn('[PersistenceProjector] Failed to build prompt breakdown:', error);
            return null;
        }
    }

    private buildTurnBootstrap() {
        return this.turn
            ? null
            : {
                  modelId: this.model.id,
                  taskId: this.taskId,
                  executionMode: this.executionMode,
                  promptSnapshotJson: JSON.stringify(this.promptSnapshot),
                  promptMessageId: this.userMessageId,
              };
    }

    async markCompleted(options: CompleteTurnOptions): Promise<void> {
        try {
            const resolvedUsage = await this.resolveUsage(options.calls, options.ttftMs);
            const result = await native.database.operation<TaskFinishResult>({
                kind: 'task_finish',
                input: {
                    sessionId: this.getSessionId(),
                    turnId: this.turn?.id ?? null,
                    attemptId: this.attemptState?.entity.id ?? null,
                    assistantMessageId: this.assistantMessageId,
                    pendingMessageId: this.pendingOutputMessageId,
                    status: 'completed',
                    errorMessage: null,
                    durationMs: options.durationMs,
                    tokensUsed: options.tokensUsed ?? null,
                    finishedAt: toDbTimestamp(new Date()),
                    parts: options.outputParts.map(toOutputPartInput),
                    usage: resolvedUsage.usage,
                    behavior: this.buildBehavior(
                        options.firstTextMs,
                        resolvedUsage.toolCallCount,
                        options.toolArgumentErrors,
                        options.modelSwitchCount,
                        options.hitModelSwitchCeiling
                    ),
                    turnBootstrap: this.buildTurnBootstrap(),
                },
            });
            this.applyFinishResult(result);
        } catch (error) {
            log.error('[PersistenceProjector] Failed to mark turn as completed:', error);
            throw error;
        }
    }

    async markFailed(
        errorMessage: string,
        outputParts?: PersistedOutputPart[],
        usage?: TerminalUsageOptions
    ): Promise<void> {
        try {
            const resolvedUsage = await this.resolveUsage(usage?.calls, usage?.ttftMs);
            const result = await native.database.operation<TaskFinishResult>({
                kind: 'task_finish',
                input: {
                    sessionId: this.getSessionId(),
                    turnId: this.turn?.id ?? null,
                    attemptId: this.attemptState?.entity.id ?? null,
                    assistantMessageId: this.assistantMessageId,
                    pendingMessageId: this.pendingOutputMessageId,
                    status: 'failed',
                    errorMessage,
                    durationMs: this.getTurnDurationMs(),
                    finishedAt: toDbTimestamp(new Date()),
                    parts: outputParts?.map(toOutputPartInput),
                    usage: resolvedUsage.usage,
                    behavior: this.buildBehavior(
                        usage?.firstTextMs,
                        resolvedUsage.toolCallCount,
                        usage?.toolArgumentErrors,
                        usage?.modelSwitchCount,
                        usage?.hitModelSwitchCeiling,
                        usage?.errorCode,
                        usage?.retryScope
                    ),
                    turnBootstrap: this.buildTurnBootstrap(),
                },
            });
            this.applyFinishResult(result);
        } catch (error) {
            log.error('[PersistenceProjector] Failed to mark turn as failed:', error);
            throw error;
        }
    }

    async markCancelled(
        outputParts?: PersistedOutputPart[],
        usage?: TerminalUsageOptions
    ): Promise<void> {
        try {
            const resolvedUsage = await this.resolveUsage(usage?.calls, usage?.ttftMs);
            const result = await native.database.operation<TaskFinishResult>({
                kind: 'task_finish',
                input: {
                    sessionId: this.getSessionId(),
                    turnId: this.turn?.id ?? null,
                    attemptId: this.attemptState?.entity.id ?? null,
                    assistantMessageId: this.assistantMessageId,
                    pendingMessageId: this.pendingOutputMessageId,
                    status: 'cancelled',
                    errorMessage: 'Cancelled by user',
                    durationMs: this.getTurnDurationMs(),
                    finishedAt: toDbTimestamp(new Date()),
                    parts: outputParts?.map(toOutputPartInput),
                    usage: resolvedUsage.usage,
                    behavior: this.buildBehavior(
                        usage?.firstTextMs,
                        resolvedUsage.toolCallCount,
                        usage?.toolArgumentErrors,
                        usage?.modelSwitchCount,
                        usage?.hitModelSwitchCeiling,
                        usage?.errorCode,
                        usage?.retryScope
                    ),
                    turnBootstrap: this.buildTurnBootstrap(),
                },
            });
            this.applyFinishResult(result);
        } catch (error) {
            log.error('[PersistenceProjector] Failed to mark turn as cancelled:', error);
            throw error;
        }
    }

    async beginNextAttempt(
        errorMessage: string,
        checkpoint: AttemptCheckpoint,
        usage?: Pick<
            TerminalUsageOptions,
            | 'calls'
            | 'ttftMs'
            | 'firstTextMs'
            | 'toolArgumentErrors'
            | 'modelSwitchCount'
            | 'hitModelSwitchCeiling'
        >
    ): Promise<void> {
        try {
            const currentAttempt = this.attemptState;
            if (!currentAttempt) {
                throw new Error('Session turn attempt not initialized');
            }
            const now = Date.now();
            const emptyDeliveryManifest = createEmptyAttachmentDeliveryManifest();
            const resolvedUsage = await this.resolveUsage(usage?.calls, usage?.ttftMs);
            const result = await native.database.operation<TaskAttemptResult>({
                kind: 'task_begin_next_attempt',
                input: {
                    turnId: this.getTurnId(),
                    currentAttemptId: currentAttempt.entity.id,
                    currentAttemptIndex: currentAttempt.entity.attempt_index,
                    errorMessage,
                    durationMs: currentAttempt.getDurationMs(),
                    finishedAt: toDbTimestamp(new Date(now)),
                    attemptIndex: currentAttempt.entity.attempt_index + 1,
                    maxRetries: this.maxRetries,
                    checkpointJson: serializeCheckpoint(checkpoint),
                    deliveryManifestJson: serializeCurrentDeliveryManifest(emptyDeliveryManifest),
                    startedAt: toDbTimestamp(new Date(now)),
                    usage: resolvedUsage.usage,
                    behavior: this.buildBehavior(
                        usage?.firstTextMs,
                        resolvedUsage.toolCallCount,
                        usage?.toolArgumentErrors,
                        usage?.modelSwitchCount,
                        usage?.hitModelSwitchCeiling
                    ),
                },
            });

            this.deliveryManifest = emptyDeliveryManifest;
            this.turn = result.turn;
            this.attemptState = new AttemptState(result.attempt, now);
            this.attemptGeneration += 1;
            this.lastProgressStep = -1;
        } catch (error) {
            log.error('[PersistenceProjector] Failed to begin next attempt:', error);
            throw error;
        }
    }

    private async resolveUsage(
        calls: AiCallRecord[] | undefined,
        ttftMs: number | null | undefined
    ): Promise<ResolvedUsage> {
        if (!calls?.length) {
            return { usage: null, toolCallCount: 0 };
        }

        const resolved = await resolveCalls(calls);
        const usage = sumUsage(resolved);
        const cost = sumCost(resolved);
        const now = Date.now();
        const turnId = this.turn?.id ?? null;
        const callParts = resolved.map((item) => {
            const { durationMs, ttftMs: callTtftMs } = item.record.timing;
            const startedAt = callTtftMs === undefined ? null : now - durationMs;
            return {
                data: JSON.stringify(buildLlmCallPartData(item, turnId)),
                startedAt,
                endedAt: startedAt === null ? null : startedAt + durationMs,
            };
        });

        return {
            usage: {
                calls: callParts,
                summary: {
                    inputTokens: usage.inputTokens,
                    outputTokens: usage.outputTokens,
                    cacheReadTokens: usage.cacheReadTokens,
                    cacheWriteTokens: usage.cacheWriteTokens,
                    reasoningTokens: usage.reasoningTokens,
                    totalCostMicros: cost.totalCostMicros,
                    unpricedCalls: countUnpriced(resolved),
                    ttftMs: ttftMs ?? null,
                    llmCallCount: resolved.length,
                },
            },
            toolCallCount: calls.reduce((sum, call) => sum + call.toolCallsInStep, 0),
        };
    }

    private buildBehavior(
        firstTextMs: number | null | undefined,
        toolCallCount: number,
        toolArgumentErrors: number | undefined,
        modelSwitchCount: number | undefined,
        hitModelSwitchCeiling: boolean | undefined,
        errorCode?: string | null,
        retryScope?: string | null
    ): DatabaseTurnBehaviorSignals {
        return {
            firstTextMs: firstTextMs ?? null,
            toolCallCount,
            toolArgumentErrorCount: toolArgumentErrors ?? 0,
            modelSwitchCount: modelSwitchCount ?? 0,
            hitIterationCeiling: hitModelSwitchCeiling ?? false,
            errorCode: errorCode ?? null,
            retryScope: retryScope ?? null,
        };
    }

    private applyFinishResult(result: TaskFinishResult): void {
        this.assistantMessageId = result.assistant_message_id;
        this.turn = result.turn;
        if (result.attempt) {
            this.attemptState = new AttemptState(
                result.attempt,
                this.attemptState?.startedAtMs ?? Date.now()
            );
        }
    }

    getTurn(): SessionTurnEntity | null {
        return this.turn;
    }

    getSessionId(): number {
        if (this.sessionId === null) {
            throw new Error('Session record not initialized');
        }
        return this.sessionId;
    }

    async syncDeliveryManifestRequest(request: AttachmentDeliveryManifestRequest): Promise<void> {
        this.deliveryManifest = upsertAttachmentDeliveryManifestRequest(
            this.deliveryManifest,
            request
        );
        if (!this.attemptState) {
            return;
        }

        const deliveryManifestJson = serializeCurrentDeliveryManifest(this.deliveryManifest);
        const attempt = await native.database.operation<SessionTurnAttemptEntity>({
            kind: 'task_update_attempt',
            input: {
                attemptId: this.attemptState.entity.id,
                deliveryManifestJson,
            },
        });
        this.attemptState = new AttemptState(attempt, this.attemptState.startedAtMs);
    }

    async persistToolCallMessage(outputParts: PersistedOutputPart[]): Promise<number> {
        const result = await native.database.operation<TaskOutputMessageResult>({
            kind: 'task_persist_output_message',
            input: {
                sessionId: this.getSessionId(),
                turnId: this.getTurnId(),
                messageId: this.pendingOutputMessageId,
                role: 'tool_call',
                linkTurn: false,
                parts: normalizeOutputParts(outputParts).map(toOutputPartInput),
            },
        });
        this.pendingOutputMessageId = null;
        return result.message.id;
    }

    async persistToolResult(options: {
        result: string;
        toolCallId?: string | null;
        toolCallPartId: number | null;
        toolCallMessageId: number | null;
        attachments?: AttachmentIndex[];
    }): Promise<void> {
        const attachments = options.attachments ?? [];
        const prepared = await Promise.all(
            attachments.map((attachment) => prepareAttachmentForPersistence(attachment))
        );
        const result = await native.database.operation<TaskToolResult>({
            kind: 'task_persist_tool_result',
            input: {
                toolCallPartId: options.toolCallPartId,
                toolCallId: options.toolCallId ?? null,
                toolCallMessageId: options.toolCallMessageId,
                result: options.result,
                attachments: attachments.map((attachment, index) =>
                    toAttachmentInput(attachment, prepared[index]!)
                ),
            },
        });
        if (!result.part) {
            log.error(
                '[persistence] Tool result has no tool_call part to attach to; dropping it.',
                {
                    toolCallId: options.toolCallId,
                    toolCallMessageId: options.toolCallMessageId,
                }
            );
        }
    }

    async persistOutputProgress(
        parts: PersistedOutputPart[],
        identity: { attemptGeneration: number; step: number }
    ): Promise<void> {
        if (!this.attemptState || parts.length === 0) return;
        if (identity.attemptGeneration !== this.attemptGeneration) return;
        if (identity.step < this.lastProgressStep) return;
        this.lastProgressStep = identity.step;
        const normalized = normalizeOutputParts(parts);
        if (normalized.length === 0) return;
        const result = await native.database.operation<TaskOutputMessageResult>({
            kind: 'task_persist_output_message',
            input: {
                sessionId: this.getSessionId(),
                turnId: this.getTurnId(),
                messageId: this.pendingOutputMessageId,
                role: 'assistant',
                linkTurn: true,
                parts: normalized.map(toOutputPartInput),
            },
        });
        this.pendingOutputMessageId = result.message.id;
        if (result.turn) {
            this.turn = result.turn;
        }
    }

    async persistCheckpoint(checkpoint: AttemptCheckpoint): Promise<void> {
        if (!this.attemptState) return;
        const attempt = await native.database.operation<SessionTurnAttemptEntity>({
            kind: 'task_update_attempt',
            input: {
                attemptId: this.attemptState.entity.id,
                checkpointJson: serializeCheckpoint(checkpoint),
            },
        });
        this.attemptState = new AttemptState(attempt, this.attemptState.startedAtMs);
    }

    private getTurnId(): number {
        if (!this.turn) {
            throw new Error('Session turn record not initialized');
        }
        return this.turn.id;
    }

    private getTurnDurationMs(): number | null {
        return this.turnStartedAtMs === null
            ? null
            : Math.max(0, Date.now() - this.turnStartedAtMs);
    }
}
