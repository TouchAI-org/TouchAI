// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { type DatabaseExecutor, db } from '@database';
import {
    createMessage,
    createMessageAttachment,
    createMessageParts,
    createSession,
    createSessionTurn,
    createSessionTurnAttempt,
    findToolCallPartByCallId,
    mergeMessagePartData,
    refreshSessionMetadata,
    syncOutputParts,
    updateMessage,
    updateSession,
    updateSessionTurn,
    updateSessionTurnAttempt,
} from '@database/queries';
import type { MessageRole, TurnStatus } from '@database/schema';
import type { AttachmentEntity } from '@database/types';
import type {
    SessionTurnAttemptEntity,
    SessionTurnEntity,
    SessionTurnUpdateData,
} from '@database/types';

import {
    type AttachmentIndex,
    createEmptyAttachmentDeliveryManifest,
    ensurePersistedAttachmentIndex,
    serializeAttachmentDeliveryManifest,
    upsertAttachmentDeliveryManifestRequest,
} from '@/services/AgentService/infrastructure/attachments';
import { toDbTimestamp } from '@/utils/date';

import {
    type AttachmentDeliveryManifest,
    type AttachmentDeliveryManifestRequest,
    normalizeOutputParts,
    type PersistedOutputPart,
} from '../contracts/protocol';
import type { AttemptCheckpoint } from '../execution/executor';
import type { PromptSnapshot } from '../prompt/types';
import type { TaskExecutionMode } from '../task/types';

/**
 * 封装轮次尝试状态，确保实体对象与开始时间戳保持一致。
 */
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
}

/**
 * 负责 AI 轮次相关记录持久化：会话、消息、轮次与轮次尝试记录。
 *
 * 采用分阶段记录：
 * - 开始：写入用户消息，并创建流式处理中状态的轮次与首个尝试记录
 * - 完成：写入助手消息，并更新当前尝试与轮次状态
 * - 失败/取消：更新当前尝试与轮次状态
 * - 重试：结束当前失败尝试，并创建下一次尝试
 */
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

export class PersistenceProjector {
    private readonly prompt: string;
    private readonly attachments: AttachmentIndex[];
    private readonly model: PersistenceProjectorModel;
    private readonly taskId: string;
    private readonly executionMode: TaskExecutionMode;
    private readonly promptSnapshot: PromptSnapshot;
    private deliveryManifest: AttachmentDeliveryManifest;
    private readonly maxRetries: number;
    private readonly buildSessionTitle: (prompt: string) => string;

    private sessionId: number | null;
    private sessionCreationPromise: Promise<number> | null;

    private userMessageId: number | null;
    private assistantMessageId: number | null;
    private pendingOutputMessageId: number | null = null;
    private turn: SessionTurnEntity | null;
    private turnStartedAtMs: number | null;
    private attemptState: AttemptState | null;

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
        this.sessionCreationPromise = null;
        this.userMessageId = null;
        this.assistantMessageId = null;
        this.turn = null;
        this.turnStartedAtMs = null;
        this.attemptState = null;
    }

    /**
     * 记录轮次开始阶段：先记录用户消息，再创建流式处理中状态的轮次与首次尝试记录。
     */
    async recordTurnStart(initialCheckpoint: AttemptCheckpoint): Promise<void> {
        const result = await db.transaction(async (tx) => {
            await this.syncSessionIdentity(tx);

            const persistedAttachments =
                this.userMessageId || this.attachments.length === 0
                    ? []
                    : await Promise.all(
                          this.attachments.map((attachment) =>
                              ensurePersistedAttachmentIndex(attachment, tx)
                          )
                      );

            const sessionId = await this.ensureSessionId(tx);
            const userMessageId =
                this.userMessageId ??
                (await this.persistMessage({
                    role: 'user',
                    content: this.prompt,
                    attachments: persistedAttachments,
                    database: tx,
                    sessionId,
                }));
            const turn = await this.ensureTurnRecord(tx, sessionId, userMessageId);
            const attemptState = await this.ensureAttemptRecord(1, initialCheckpoint, tx, turn.id);

            return { sessionId, userMessageId, turn, attemptState };
        });

        this.sessionId = result.sessionId;
        this.userMessageId = result.userMessageId;
        this.turn = result.turn;
        this.attemptState = result.attemptState;
    }

    /**
     * 当前轮次成功阶段：记录助手回复并更新状态。
     */
    async markCompleted(options: CompleteTurnOptions): Promise<void> {
        try {
            const result = await db.transaction(async (tx) => {
                const assistantMessageId =
                    (options.outputParts.length || this.pendingOutputMessageId !== null) &&
                    !this.assistantMessageId
                        ? await this.persistMessage({
                              role: 'assistant',
                              outputParts: options.outputParts,
                              database: tx,
                          })
                        : (this.assistantMessageId ?? this.pendingOutputMessageId);

                const attemptState = await this.finishCurrentAttempt('completed', null, tx);
                const turn = await this.patchTurn(
                    {
                        status: 'completed',
                        error_message: null,
                        response_message_id: assistantMessageId,
                        tokens_used: options.tokensUsed ?? null,
                        duration_ms: options.durationMs,
                    },
                    tx
                );

                return { assistantMessageId, attemptState, turn };
            });

            this.assistantMessageId = result.assistantMessageId;
            this.attemptState = result.attemptState;
            this.turn = result.turn;
        } catch (error) {
            console.error('[PersistenceProjector] Failed to mark turn as completed:', error);
            throw error;
        }
    }

    /**
     * 当前轮次失败阶段：更新最终失败状态和错误信息。
     */
    async markFailed(errorMessage: string, outputParts?: PersistedOutputPart[]): Promise<void> {
        try {
            const result = await db.transaction(async (tx) => {
                const assistantMessageId =
                    outputParts !== undefined &&
                    (outputParts.length || this.pendingOutputMessageId !== null) &&
                    !this.assistantMessageId
                        ? await this.persistMessage({
                              role: 'assistant',
                              outputParts,
                              database: tx,
                          })
                        : (this.assistantMessageId ?? this.pendingOutputMessageId);

                const attemptState = await this.finishCurrentAttempt('failed', errorMessage, tx);
                const turn = await this.patchTurn(
                    {
                        status: 'failed',
                        error_message: errorMessage,
                        response_message_id: assistantMessageId,
                        duration_ms: this.getTurnDurationMs(),
                    },
                    tx
                );

                return { assistantMessageId, attemptState, turn };
            });

            this.assistantMessageId = result.assistantMessageId;
            this.attemptState = result.attemptState;
            this.turn = result.turn;
        } catch (error) {
            console.error('[PersistenceProjector] Failed to mark turn as failed:', error);
            throw error;
        }
    }

    /**
     * 当前轮次取消阶段：更新取消状态。
     */
    async markCancelled(outputParts?: PersistedOutputPart[]): Promise<void> {
        try {
            const result = await db.transaction(async (tx) => {
                const assistantMessageId =
                    outputParts !== undefined &&
                    (outputParts.length || this.pendingOutputMessageId !== null) &&
                    !this.assistantMessageId
                        ? await this.persistMessage({
                              role: 'assistant',
                              outputParts,
                              database: tx,
                          })
                        : (this.assistantMessageId ?? this.pendingOutputMessageId);

                const attemptState = await this.finishCurrentAttempt(
                    'cancelled',
                    'Cancelled by user',
                    tx
                );
                const turn = await this.patchTurn(
                    {
                        status: 'cancelled',
                        error_message: 'Cancelled by user',
                        response_message_id: assistantMessageId,
                        duration_ms: this.getTurnDurationMs(),
                    },
                    tx
                );

                return { assistantMessageId, attemptState, turn };
            });

            this.assistantMessageId = result.assistantMessageId;
            this.attemptState = result.attemptState;
            this.turn = result.turn;
        } catch (error) {
            console.error('[PersistenceProjector] Failed to mark turn as cancelled:', error);
            throw error;
        }
    }

    /**
     * 当前尝试可重试时，先标记失败，再创建下一次尝试。
     */
    async beginNextAttempt(errorMessage: string, checkpoint: AttemptCheckpoint): Promise<void> {
        try {
            const emptyDeliveryManifest = createEmptyAttachmentDeliveryManifest();
            const result = await db.transaction(async (tx) => {
                await this.finishCurrentAttempt('failed', errorMessage, tx);

                const nextAttemptIndex = (this.attemptState?.entity.attempt_index ?? 0) + 1;
                const startedAt = Date.now();
                const startedAtText = toDbTimestamp(new Date(startedAt));
                const nextAttempt = await createSessionTurnAttempt(
                    {
                        turn_id: this.getTurnId(),
                        attempt_index: nextAttemptIndex,
                        max_retries: this.maxRetries,
                        status: 'streaming',
                        checkpoint_json: serializeCheckpoint(checkpoint),
                        delivery_manifest_json:
                            serializeCurrentDeliveryManifest(emptyDeliveryManifest),
                        started_at: startedAtText,
                        created_at: startedAtText,
                        updated_at: startedAtText,
                    },
                    tx
                );

                const attemptState = new AttemptState(nextAttempt, startedAt);
                let turn = this.turn;
                if (this.turn?.status !== 'streaming' || this.turn?.error_message !== null) {
                    turn = await this.patchTurn(
                        {
                            status: 'streaming',
                            error_message: null,
                        },
                        tx
                    );
                }

                return { attemptState, turn };
            });

            this.deliveryManifest = emptyDeliveryManifest;
            this.attemptState = result.attemptState;
            this.turn = result.turn;
        } catch (error) {
            console.error('[PersistenceProjector] Failed to begin next attempt:', error);
            throw error;
        }
    }

    /**
     * 获取当前轮次记录（可能为空）。
     */
    getTurn(): SessionTurnEntity | null {
        return this.turn;
    }

    /**
     * 获取当前会话 ID（可能为空）。
     */
    getSessionId(): number | null {
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
        await db.transaction(async (tx) => {
            await updateSessionTurnAttempt({
                id: this.attemptState!.entity.id,
                attemptPatch: {
                    delivery_manifest_json: deliveryManifestJson,
                },
                database: tx,
            });
        });

        this.attemptState = new AttemptState(
            {
                ...this.attemptState.entity,
                delivery_manifest_json: deliveryManifestJson,
            },
            this.attemptState.startedAtMs
        );
    }

    /**
     * 持久化工具调用消息。
     */
    async persistToolCallMessage(outputParts: PersistedOutputPart[]): Promise<number> {
        const messageId = await db.transaction((tx) =>
            this.persistMessage({ role: 'tool_call', outputParts, database: tx })
        );
        this.pendingOutputMessageId = null;
        return messageId;
    }

    /**
     * 把工具结果写回对应的 tool_call 片段。
     *
     * 工具执行服务已写入 output/status/duration；这里负责兜底补齐结果文本，
     * 并把结果附件挂到工具调用所在消息上（附件 data 记录 toolCallId 归属）。
     *
     * 结果**只能**落在 `tool_call` 片段上。片段主键丢了就按 `tool_call_id` 反查，
     * 实在找不到宁愿丢掉并报错，也绝不把结果写成一条助手文本——
     * 那会让工具输出混进模型正文，在对话里渲染成大段原始内容。
     */
    async persistToolResult(options: {
        result: string;
        toolCallId?: string | null;
        toolCallPartId: number | null;
        toolCallMessageId: number | null;
        attachments?: AttachmentIndex[];
    }): Promise<void> {
        const { result, toolCallId, attachments = [] } = options;
        let partId = options.toolCallPartId;

        // 只在拿到消息 id 时才反查：`tool_call_id` 只保证在单条消息内唯一，
        // 不限定的反查可能命中更早消息里的同 id 片段，把结果写错地方。
        if (partId === null && toolCallId && options.toolCallMessageId !== null) {
            const found = await findToolCallPartByCallId(toolCallId, options.toolCallMessageId);
            partId = found?.id ?? null;
        }

        if (partId === null) {
            console.error(
                '[persistence] Tool result has no tool_call part to attach to; dropping it.',
                { toolCallId, toolCallMessageId: options.toolCallMessageId }
            );
            return;
        }

        await db.transaction(async (tx) => {
            const part = await mergeMessagePartData(partId, { output: result }, tx);
            if (!part) {
                return;
            }

            if (attachments.length > 0) {
                const persisted = await Promise.all(
                    attachments.map((attachment) => ensurePersistedAttachmentIndex(attachment, tx))
                );
                for (const [index, entity] of persisted.entries()) {
                    const source = attachments[index]!;
                    await createMessageAttachment(
                        {
                            message_id: part.message_id,
                            attachment_id: entity.id,
                            origin_path: source.originPath,
                            tool_call_id: part.tool_call_id,
                            tool_kind: part.tool_kind,
                        },
                        tx
                    );
                }
            }

            await refreshSessionMetadata(await this.ensureSessionId(tx), tx);
        });
    }

    /** 片段边界写入正式 parts（推理开始/结束、正文结束）；没有定时快照。 */
    async persistOutputProgress(parts: PersistedOutputPart[]): Promise<void> {
        if (!this.attemptState || parts.length === 0) return;
        const normalized = normalizeOutputParts(parts);
        if (normalized.length === 0) return;
        const result = await db.transaction(async (tx) => {
            const messageId = await this.persistMessage({
                role: 'assistant',
                outputParts: normalized,
                database: tx,
            });
            const turn = await this.patchTurn({ response_message_id: messageId }, tx);
            return { messageId, turn };
        });
        this.pendingOutputMessageId = result.messageId;
        this.turn = result.turn;
    }

    async persistCheckpoint(checkpoint: AttemptCheckpoint): Promise<void> {
        if (!this.attemptState) {
            return;
        }

        const checkpointJson = serializeCheckpoint(checkpoint);
        await db.transaction(async (tx) => {
            await updateSessionTurnAttempt({
                id: this.attemptState!.entity.id,
                attemptPatch: {
                    checkpoint_json: checkpointJson,
                },
                database: tx,
            });
        });

        this.attemptState = new AttemptState(
            {
                ...this.attemptState.entity,
                checkpoint_json: checkpointJson,
                delivery_manifest_json: this.attemptState.entity.delivery_manifest_json,
            },
            this.attemptState.startedAtMs
        );
    }

    private async ensureSessionId(database: DatabaseExecutor = db): Promise<number> {
        if (this.sessionId) {
            return this.sessionId;
        }

        if (this.sessionCreationPromise) {
            return this.sessionCreationPromise;
        }

        // 并发写入可能同时触发懒创建，这里用单实例 Promise 锁保证只落一条 session。
        const sessionCreationPromise = createSession(
            {
                session_id: crypto.randomUUID(),
                title: this.buildSessionTitle(this.prompt),
                model: this.model.model_id,
                provider_id: this.model.provider_id,
            },
            database
        ).then((session) => {
            this.sessionId = session.id;
            return session.id;
        });

        this.sessionCreationPromise = sessionCreationPromise;

        try {
            return await sessionCreationPromise;
        } finally {
            if (this.sessionCreationPromise === sessionCreationPromise) {
                this.sessionCreationPromise = null;
            }
        }
    }

    /**
     * `useAgent` 可能会先按“当前选中的标签”预创建会话，
     * 等真正解析出默认模型后，再由持久化层把会话的模型和提供方校准成最终值。
     */
    private async syncSessionIdentity(database: DatabaseExecutor = db): Promise<void> {
        if (!this.sessionId) {
            return;
        }

        try {
            await updateSession({
                id: this.sessionId,
                sessionPatch: {
                    model: this.model.model_id,
                    provider_id: this.model.provider_id,
                },
                database,
            });
        } catch (error) {
            console.error('[PersistenceProjector] Failed to sync session identity:', error);
        }
    }

    private async persistMessage({
        role,
        content = '',
        outputParts = [],
        attachments = [],
        database = db,
        sessionId,
    }: {
        role: MessageRole;
        content?: string;
        outputParts?: PersistedOutputPart[];
        attachments?: Array<AttachmentIndex | AttachmentEntity>;
        database?: DatabaseExecutor;
        sessionId?: number;
    }): Promise<number> {
        const resolvedSessionId = sessionId ?? (await this.ensureSessionId(database));

        const reusableMessageId =
            role === 'assistant' || role === 'tool_call' ? this.pendingOutputMessageId : null;
        let messageId: number;
        if (reusableMessageId !== null) {
            messageId = reusableMessageId;
            await updateMessage(messageId, { role }, database);
        } else {
            const message = await createMessage(
                {
                    session_id: resolvedSessionId,
                    role,
                },
                database
            );
            messageId = message.id;
        }

        const persistedParts = normalizeOutputParts(outputParts);
        if ((role === 'assistant' || role === 'tool_call') && persistedParts.length > 0) {
            await syncOutputParts(
                messageId,
                persistedParts.map((part, sortOrder) => ({
                    message_id: messageId,
                    type: part.type,
                    content: part.content,
                    ...(part.type === 'reasoning' && part.providerOptions
                        ? { data: JSON.stringify(part.providerOptions) }
                        : {}),
                    started_at: part.type === 'reasoning' ? (part.startedAt ?? null) : null,
                    ended_at: part.type === 'reasoning' ? (part.endedAt ?? null) : null,
                    sort_order: sortOrder,
                })),
                database
            );
        } else if (content) {
            await createMessageParts(
                [{ message_id: messageId, type: 'text', content, sort_order: 0 }],
                database
            );
        }

        await refreshSessionMetadata(resolvedSessionId, database);

        if (role === 'user' && attachments.length > 0) {
            const persisted = await Promise.all(
                attachments.map((attachment) =>
                    'attachmentId' in attachment || !('original_name' in attachment)
                        ? ensurePersistedAttachmentIndex(attachment as AttachmentIndex, database)
                        : Promise.resolve(attachment as AttachmentEntity)
                )
            );

            for (const [index, entity] of persisted.entries()) {
                const source = attachments[index]!;
                const originPath = 'originPath' in source ? source.originPath : source.origin_path;
                await createMessageAttachment(
                    {
                        message_id: messageId,
                        attachment_id: entity.id,
                        origin_path: originPath,
                    },
                    database
                );
            }
        }

        return messageId;
    }

    private async ensureTurnRecord(
        database: DatabaseExecutor = db,
        sessionId?: number,
        promptMessageId?: number | null
    ): Promise<SessionTurnEntity> {
        if (this.turn) {
            return this.turn;
        }

        const resolvedSessionId = sessionId ?? (await this.ensureSessionId(database));

        const startedAt = Date.now();

        const turn = await createSessionTurn(
            {
                session_id: resolvedSessionId,
                model_id: this.model.id,
                task_id: this.taskId,
                execution_mode: this.executionMode,
                prompt_snapshot_json: JSON.stringify(this.promptSnapshot),
                prompt_message_id: promptMessageId ?? this.userMessageId,
                response_message_id: null,
                status: 'streaming',
            },
            database
        );
        this.turnStartedAtMs = startedAt;
        return turn;
    }

    private async ensureAttemptRecord(
        attemptIndex: number,
        checkpoint: AttemptCheckpoint,
        database: DatabaseExecutor = db,
        turnId?: number
    ): Promise<AttemptState> {
        if (this.attemptState) {
            return this.attemptState;
        }

        const resolvedTurnId = turnId ?? this.getTurnId();
        const startedAt = Date.now();
        const startedAtText = toDbTimestamp(new Date(startedAt));

        const attempt = await createSessionTurnAttempt(
            {
                turn_id: resolvedTurnId,
                attempt_index: attemptIndex,
                max_retries: this.maxRetries,
                status: 'streaming',
                checkpoint_json: serializeCheckpoint(checkpoint),
                delivery_manifest_json: serializeCurrentDeliveryManifest(this.deliveryManifest),
                started_at: startedAtText,
                created_at: startedAtText,
                updated_at: startedAtText,
            },
            database
        );
        return new AttemptState(attempt, startedAt);
    }

    private async finishCurrentAttempt(
        status: TurnStatus,
        errorMessage: string | null = null,
        database: DatabaseExecutor = db
    ): Promise<AttemptState | null> {
        if (!this.attemptState) {
            return null;
        }

        const finishedAt = Date.now();
        const durationMs = this.attemptState.getDurationMs();
        const finishedAtText = toDbTimestamp(new Date(finishedAt));

        await updateSessionTurnAttempt({
            id: this.attemptState.entity.id,
            attemptPatch: {
                status,
                error_message: errorMessage,
                duration_ms: durationMs,
                finished_at: finishedAtText,
                updated_at: finishedAtText,
            },
            database,
        });

        return new AttemptState(
            {
                ...this.attemptState.entity,
                status,
                error_message: errorMessage,
                duration_ms: durationMs,
                finished_at: finishedAtText,
                updated_at: finishedAtText,
            },
            this.attemptState.startedAtMs
        );
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

    private async patchTurn(
        patch: SessionTurnUpdateData,
        database: DatabaseExecutor = db
    ): Promise<SessionTurnEntity | null> {
        if (!this.turn) {
            const turn = await this.ensureTurnRecord(database);
            this.turn = turn;
        }

        if (!this.turn) {
            return null;
        }

        try {
            await updateSessionTurn({
                id: this.turn.id,
                turnPatch: patch,
                database,
            });
            return {
                ...this.turn,
                ...patch,
            };
        } catch (persistError) {
            console.error(
                '[PersistenceProjector] Failed to update session turn record:',
                persistError
            );
            return this.turn;
        }
    }
}
