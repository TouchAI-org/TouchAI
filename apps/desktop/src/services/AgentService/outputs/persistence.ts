// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { type DatabaseExecutor, db } from '@database';
import {
    appendMessagePart,
    createMessage,
    createMessageAttachment,
    createMessageParts,
    createSession,
    createSessionTurn,
    createSessionTurnAttempt,
    findAllBuiltInTools,
    findAllMcpTools,
    mergeMessagePartData,
    refreshSessionMetadata,
    syncOutputParts,
    updateMessage,
    updateSession,
    updateSessionTurn,
    updateSessionTurnAttempt,
    updateSessionTurnAttemptUsage,
    updateSessionTurnUsage,
} from '@database/queries';
import type { MessageRole, TurnStatus } from '@database/schema';
import { sessionTurnAttempts } from '@database/schema';
import type { AttachmentEntity } from '@database/types';
import type {
    SessionTurnAttemptEntity,
    SessionTurnEntity,
    SessionTurnUpdateData,
    SessionTurnUsagePatch,
} from '@database/types';
import { type AnyColumn, type SQL, sql } from 'drizzle-orm';

import {
    type AttachmentIndex,
    createEmptyAttachmentDeliveryManifest,
    ensurePersistedAttachmentIndex,
    serializeAttachmentDeliveryManifest,
    upsertAttachmentDeliveryManifestRequest,
} from '@/services/AgentService/infrastructure/attachments';
import {
    countUnpriced,
    insertLlmCallParts,
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
    /** 本回合全部 LLM 调用记录（含每次调用的用量与耗时） */
    calls?: AiCallRecord[];
    ttftMs?: number | null;
    firstTextMs?: number | null;
    toolArgumentErrors?: number;
    modelSwitchCount?: number;
    hitModelSwitchCeiling?: boolean;
}

/** 失败/取消时的用量写入参数 */
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

            // prompt 分片统计：只算字符数，成本可忽略，但让 Context 页
            // 不必在查询时重解析 8 段文本。
            const breakdown = await this.buildPromptBreakdownSnapshot();
            if (breakdown) {
                await updateSessionTurnUsage({
                    id: turn.id,
                    usagePatch: { prompt_breakdown_json: JSON.stringify(breakdown) },
                    database: tx,
                });
            }

            return { sessionId, userMessageId, turn, attemptState };
        });

        this.sessionId = result.sessionId;
        this.userMessageId = result.userMessageId;
        this.turn = result.turn;
        this.attemptState = result.attemptState;
    }

    /**
     * 计算本次回合的 prompt 分片统计。
     *
     * 工具定义从库里的 schema 算（而非从发出去的请求体），
     * 因为请求体可能因模型能力而裁剪，而这里统计的是「工具箱本身有多大」。
     * 失败不影响对话主流程，只跳过本次统计。
     */
    private async buildPromptBreakdownSnapshot(): Promise<PromptBreakdownJson | null> {
        try {
            const [mcpTools, builtInTools] = await Promise.all([
                findAllMcpTools(),
                findAllBuiltInTools(),
            ]);
            return buildPromptBreakdown(this.promptSnapshot, mcpTools, builtInTools);
        } catch (error) {
            console.warn('[PersistenceProjector] Failed to build prompt breakdown:', error);
            return null;
        }
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

                // 用量先落库：消息可能不存在（无可见输出），此时只写聚合列。
                const usagePatch = await this.persistUsage({
                    messageId: assistantMessageId,
                    calls: options.calls,
                    ttftMs: options.ttftMs,
                    firstTextMs: options.firstTextMs,
                    toolArgumentErrors: options.toolArgumentErrors,
                    modelSwitchCount: options.modelSwitchCount,
                    hitModelSwitchCeiling: options.hitModelSwitchCeiling,
                    database: tx,
                });

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

                if (turn && Object.keys(usagePatch).length > 0) {
                    await updateSessionTurnUsage({ id: turn.id, usagePatch, database: tx });
                }

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
    async markFailed(
        errorMessage: string,
        outputParts?: PersistedOutputPart[],
        usage?: TerminalUsageOptions
    ): Promise<void> {
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

                const usagePatch = await this.persistUsage({
                    messageId: assistantMessageId,
                    calls: usage?.calls,
                    ttftMs: usage?.ttftMs,
                    firstTextMs: usage?.firstTextMs,
                    toolArgumentErrors: usage?.toolArgumentErrors,
                    modelSwitchCount: usage?.modelSwitchCount,
                    hitModelSwitchCeiling: usage?.hitModelSwitchCeiling,
                    errorCode: usage?.errorCode,
                    retryScope: usage?.retryScope,
                    database: tx,
                });

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

                if (turn && Object.keys(usagePatch).length > 0) {
                    await updateSessionTurnUsage({ id: turn.id, usagePatch, database: tx });
                }

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
    async markCancelled(
        outputParts?: PersistedOutputPart[],
        usage?: TerminalUsageOptions
    ): Promise<void> {
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

                const usagePatch = await this.persistUsage({
                    messageId: assistantMessageId,
                    calls: usage?.calls,
                    ttftMs: usage?.ttftMs,
                    firstTextMs: usage?.firstTextMs,
                    toolArgumentErrors: usage?.toolArgumentErrors,
                    modelSwitchCount: usage?.modelSwitchCount,
                    hitModelSwitchCeiling: usage?.hitModelSwitchCeiling,
                    errorCode: usage?.errorCode,
                    retryScope: usage?.retryScope,
                    database: tx,
                });

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

                if (turn && Object.keys(usagePatch).length > 0) {
                    await updateSessionTurnUsage({ id: turn.id, usagePatch, database: tx });
                }

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
     *
     * 失败尝试已经消耗的 token 与成本必须落库（否则重试开销全部丢失），
     * 因此 `usage` 参数把本次失败的调用记录写进对应 attempt。
     */
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
            const emptyDeliveryManifest = createEmptyAttachmentDeliveryManifest();
            const result = await db.transaction(async (tx) => {
                // 先把失败尝试的用量写入当前 attempt（此时 attemptState 仍是旧的）
                if (usage?.calls?.length) {
                    const resolved = await resolveCalls(usage.calls);
                    const failedUsage = sumUsage(resolved);
                    const failedCost = sumCost(resolved);
                    await updateSessionTurnAttemptUsage({
                        id: this.attemptState!.entity.id,
                        usagePatch: {
                            input_tokens: failedUsage.inputTokens,
                            output_tokens: failedUsage.outputTokens,
                            cache_read_tokens: failedUsage.cacheReadTokens,
                            cache_write_tokens: failedUsage.cacheWriteTokens,
                            reasoning_tokens: failedUsage.reasoningTokens,
                            total_cost_micros: failedCost.totalCostMicros,
                            unpriced_calls: countUnpriced(resolved),
                            ttft_ms: usage.ttftMs ?? null,
                            llm_call_count: resolved.length,
                        },
                        database: tx,
                    });
                }

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

                // 重试后 turn 级用量同步刷新（包含刚写入的失败尝试）
                if (turn) {
                    await updateSessionTurnUsage({
                        id: turn.id,
                        usagePatch: {
                            ...this.buildTurnUsageSumPatch(turn.id),
                            model_switch_count: usage?.modelSwitchCount ?? 0,
                            tool_argument_error_count: usage?.toolArgumentErrors ?? 0,
                            hit_iteration_ceiling: usage?.hitModelSwitchCeiling ? 1 : 0,
                        },
                        database: tx,
                    });
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
     * turn 级用量聚合补丁：从 attempts 汇总，避免多处写入产生偏差。
     * 与 `refreshSessionMetadata` 同模式（单条带子查询的 UPDATE）。
     */
    private buildTurnUsageSumPatch(turnId: number): SessionTurnUsagePatch {
        const sumAttempts = (column: AnyColumn | SQL) =>
            sql`(SELECT coalesce(sum(${column}), 0) FROM ${sessionTurnAttempts} WHERE ${sessionTurnAttempts.turn_id} = ${turnId})`;

        return {
            input_tokens: sumAttempts(sessionTurnAttempts.input_tokens),
            output_tokens: sumAttempts(sessionTurnAttempts.output_tokens),
            cache_read_tokens: sumAttempts(sessionTurnAttempts.cache_read_tokens),
            cache_write_tokens: sumAttempts(sessionTurnAttempts.cache_write_tokens),
            reasoning_tokens: sumAttempts(sessionTurnAttempts.reasoning_tokens),
            total_cost_micros: sumAttempts(sessionTurnAttempts.total_cost_micros),
            unpriced_calls: sumAttempts(sessionTurnAttempts.unpriced_calls),
            llm_call_count: sumAttempts(sessionTurnAttempts.llm_call_count),
            // 首字取第一次有值的尝试（attempt_index 最小）
            ttft_ms: sql`(SELECT ${sessionTurnAttempts.ttft_ms} FROM ${sessionTurnAttempts} WHERE ${sessionTurnAttempts.turn_id} = ${turnId} AND ${sessionTurnAttempts.ttft_ms} IS NOT NULL ORDER BY ${sessionTurnAttempts.attempt_index} LIMIT 1)`,
        };
    }

    /**
     * 写入一次 attempt 的用量。
     *
     * 职责：
     * 1. 为每次 LLM 调用插入一个 `type='llm_call'` 的片段（挂到该回合的响应消息）
     * 2. 把汇总写入 `session_turn_attempts` 的聚合列
     *
     * `messageId` 为 null 时（无可见输出）只写聚合列，不丢数据。
     * 返回 turn 级聚合列的 SQL 补丁。
     */
    private async persistUsage({
        messageId,
        calls,
        ttftMs,
        firstTextMs,
        toolArgumentErrors,
        modelSwitchCount,
        hitModelSwitchCeiling,
        errorCode,
        retryScope,
        database,
    }: {
        messageId: number | null;
        calls?: AiCallRecord[];
        ttftMs?: number | null;
        firstTextMs?: number | null;
        toolArgumentErrors?: number;
        modelSwitchCount?: number;
        hitModelSwitchCeiling?: boolean;
        errorCode?: string | null;
        retryScope?: string | null;
        database: DatabaseExecutor;
    }): Promise<SessionTurnUsagePatch> {
        // 无调用记录时没有任何用量可写，直接返回空补丁。
        // 这同时避免了无意义的数据库往返，也让不关心用量的调用路径保持原样。
        if (!calls?.length) {
            return {};
        }

        const resolved = await resolveCalls(calls);
        const usage = sumUsage(resolved);
        const cost = sumCost(resolved);
        const unpriced = countUnpriced(resolved);
        const toolCallCount = (calls ?? []).reduce((sum, call) => sum + call.toolCallsInStep, 0);

        // 1. 明细片段
        if (messageId !== null && resolved.length > 0) {
            await insertLlmCallParts(messageId, resolved, database);
        }

        const turnId = this.turn?.id ?? 0;

        // 2. attempt 级聚合
        if (this.attemptState) {
            await updateSessionTurnAttemptUsage({
                id: this.attemptState.entity.id,
                usagePatch: {
                    input_tokens: usage.inputTokens,
                    output_tokens: usage.outputTokens,
                    cache_read_tokens: usage.cacheReadTokens,
                    cache_write_tokens: usage.cacheWriteTokens,
                    reasoning_tokens: usage.reasoningTokens,
                    total_cost_micros: cost.totalCostMicros,
                    unpriced_calls: unpriced,
                    ttft_ms: ttftMs ?? null,
                    llm_call_count: resolved.length,
                },
                database,
            });
        }

        // 3. turn 级聚合列 + 行为信号
        return {
            ...this.buildTurnUsageSumPatch(turnId),
            first_text_ms: firstTextMs ?? null,
            tool_call_count: toolCallCount,
            tool_argument_error_count: toolArgumentErrors ?? 0,
            model_switch_count: modelSwitchCount ?? 0,
            hit_iteration_ceiling: hitModelSwitchCeiling ? 1 : 0,
            error_code: errorCode ?? null,
            retry_scope: retryScope ?? null,
        };
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
     * 找不到工具片段时（参数协议错误等）退化为在工具步骤消息末尾追加文本。
     */
    async persistToolResult(options: {
        result: string;
        toolCallPartId: number | null;
        toolCallMessageId: number | null;
        attachments?: AttachmentIndex[];
    }): Promise<void> {
        const { result, toolCallPartId, toolCallMessageId, attachments = [] } = options;
        if (toolCallPartId === null) {
            if (toolCallMessageId !== null && result) {
                await db.transaction(async (tx) => {
                    await appendMessagePart(
                        toolCallMessageId,
                        { type: 'text', content: result, data: '{}' },
                        tx
                    );
                    await refreshSessionMetadata(await this.ensureSessionId(tx), tx);
                });
            }
            return;
        }

        await db.transaction(async (tx) => {
            const part = await mergeMessagePartData(toolCallPartId, { output: result }, tx);
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
