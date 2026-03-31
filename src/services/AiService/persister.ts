// Copyright (c) 2026. 千诚. Licensed under GPL v3

import {
    createMessage,
    createMessageAttachment,
    createSession,
    createSessionTurn,
    createSessionTurnAttempt,
    refreshSessionMetadata,
    updateSession,
    updateSessionTurn,
    updateSessionTurnAttempt,
} from '@database/queries';
import type { MessageRole, ToolLogKind, TurnStatus } from '@database/schema';
import type {
    SessionTurnAttemptEntity,
    SessionTurnEntity,
    SessionTurnUpdateData,
} from '@database/types';
import { ensurePersistedAttachmentIndex, type Index } from '@services/AiService/attachments';

import { toDbTimestamp } from '@/utils/date';

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

interface PersisterModel {
    id: number;
    model_id: string;
    provider_id: number;
}

interface PersisterOptions {
    prompt: string;
    attachments?: Index[];
    model: PersisterModel;
    sessionId?: number | null;
    maxRetries: number;
    buildSessionTitle: (prompt: string) => string;
}

interface CompleteTurnOptions {
    response: string;
    durationMs: number;
    tokensUsed?: number | null;
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
export class Persister {
    private readonly prompt: string;
    private readonly attachments: Index[];
    private readonly model: PersisterModel;
    private readonly maxRetries: number;
    private readonly buildSessionTitle: (prompt: string) => string;

    private sessionId: number | null;

    private userMessageId: number | null;
    private assistantMessageId: number | null;
    private turn: SessionTurnEntity | null;
    private turnStartedAtMs: number | null;
    private attemptState: AttemptState | null;

    constructor(options: PersisterOptions) {
        this.prompt = options.prompt;
        this.attachments = options.attachments ?? [];
        this.model = options.model;
        this.maxRetries = options.maxRetries;
        this.buildSessionTitle = options.buildSessionTitle;

        this.sessionId = options.sessionId ?? null;
        this.userMessageId = null;
        this.assistantMessageId = null;
        this.turn = null;
        this.turnStartedAtMs = null;
        this.attemptState = null;
    }

    /**
     * 记录轮次开始阶段：先记录用户消息，再创建流式处理中状态的轮次与首次尝试记录。
     */
    async recordTurnStart(): Promise<void> {
        await this.syncSessionIdentity();

        if (!this.userMessageId) {
            this.userMessageId = await this.persistMessage(
                'user',
                this.prompt,
                null,
                null,
                this.attachments
            );
        }

        await this.ensureTurnRecord();
        await this.ensureAttemptRecord(1);
    }

    /**
     * 当前轮次成功阶段：记录助手回复并更新状态。
     */
    async markCompleted(options: CompleteTurnOptions): Promise<void> {
        if (options.response.trim() && !this.assistantMessageId) {
            this.assistantMessageId = await this.persistMessage('assistant', options.response);
        }

        await this.finishCurrentAttempt('completed');
        await this.patchTurn({
            status: 'completed',
            error_message: null,
            response_message_id: this.assistantMessageId,
            tokens_used: options.tokensUsed ?? null,
            duration_ms: options.durationMs,
        });
    }

    /**
     * 当前轮次失败阶段：更新最终失败状态和错误信息。
     */
    async markFailed(errorMessage: string, partialResponse?: string): Promise<void> {
        if (partialResponse?.trim() && !this.assistantMessageId) {
            this.assistantMessageId = await this.persistMessage('assistant', partialResponse);
        }

        await this.finishCurrentAttempt('failed', errorMessage);
        await this.patchTurn({
            status: 'failed',
            error_message: errorMessage,
            response_message_id: this.assistantMessageId,
            duration_ms: this.getTurnDurationMs(),
        });
    }

    /**
     * 当前轮次取消阶段：更新取消状态。
     */
    async markCancelled(): Promise<void> {
        await this.finishCurrentAttempt('cancelled', 'Cancelled by user');
        await this.patchTurn({
            status: 'cancelled',
            error_message: 'Cancelled by user',
            duration_ms: this.getTurnDurationMs(),
        });
    }

    /**
     * 当前尝试可重试时，先标记失败，再创建下一次尝试。
     */
    async beginNextAttempt(errorMessage: string): Promise<void> {
        await this.finishCurrentAttempt('failed', errorMessage);

        const nextAttemptIndex = (this.attemptState?.entity.attempt_index ?? 0) + 1;
        const startedAt = Date.now();
        const startedAtText = toDbTimestamp(new Date(startedAt));
        const nextAttempt = await createSessionTurnAttempt({
            turn_id: this.getTurnId(),
            attempt_index: nextAttemptIndex,
            max_retries: this.maxRetries,
            status: 'streaming',
            started_at: startedAtText,
            created_at: startedAtText,
            updated_at: startedAtText,
        });

        this.attemptState = new AttemptState(nextAttempt, startedAt);
        // 仅当状态或错误信息需要变化时才更新轮次
        if (this.turn?.status !== 'streaming' || this.turn?.error_message !== null) {
            await this.patchTurn({
                status: 'streaming',
                error_message: null,
            });
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

    /**
     * 持久化工具调用消息。
     */
    async persistToolCallMessage(text?: string): Promise<number | null> {
        return this.persistMessage('tool_call', text || '');
    }

    /**
     * 持久化工具结果消息。
     * @param toolLogId 对应工具日志表记录编号
     */
    async persistToolResultMessage(
        result: string,
        toolLogId: number | null,
        toolLogKind: ToolLogKind | null
    ): Promise<number | null> {
        return this.persistMessage('tool_result', result, toolLogId, toolLogKind);
    }

    private async ensureSessionId(): Promise<number | null> {
        if (this.sessionId) {
            return this.sessionId;
        }
        try {
            const session = await createSession({
                session_id: crypto.randomUUID(),
                title: this.buildSessionTitle(this.prompt),
                model: this.model.model_id,
                provider_id: this.model.provider_id,
            });

            this.sessionId = session.id;
            return session.id;
        } catch (sessionError) {
            console.error('[Persister] Failed to create session:', sessionError);
            return null;
        }
    }

    /**
     * `useAgent` 可能会先按“当前选中的标签”预创建会话，
     * 等真正解析出默认模型后，再由持久化层把会话的模型和提供方校准成最终值。
     */
    private async syncSessionIdentity(): Promise<void> {
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
            });
        } catch (error) {
            console.error('[Persister] Failed to sync session identity:', error);
        }
    }

    private async persistMessage(
        role: MessageRole,
        content: string,
        toolLogId?: number | null,
        toolLogKind?: ToolLogKind | null,
        attachments: Index[] = []
    ): Promise<number | null> {
        const sessionId = await this.ensureSessionId();

        if (!sessionId) {
            return null;
        }

        const message = await createMessage({
            session_id: sessionId,
            role: role as MessageRole,
            content,
            tool_log_id: toolLogId ?? null,
            tool_log_kind: toolLogKind ?? null,
        });

        await refreshSessionMetadata(sessionId);

        if (role === 'user' && attachments.length > 0) {
            const persisted = await Promise.all(
                attachments.map((attachment) => ensurePersistedAttachmentIndex(attachment))
            );

            for (const [index, entity] of persisted.entries()) {
                await createMessageAttachment({
                    message_id: message.id,
                    attachment_id: entity.id,
                    sort_order: index,
                });
            }
        }

        return message.id;
    }

    private async ensureTurnRecord(): Promise<void> {
        if (this.turn) {
            return;
        }

        const sessionId = await this.ensureSessionId();
        const startedAt = Date.now();

        this.turn = await createSessionTurn({
            session_id: sessionId,
            model_id: this.model.id,
            prompt_message_id: this.userMessageId,
            response_message_id: this.assistantMessageId,
            status: 'streaming',
        });
        this.turnStartedAtMs = startedAt;
    }

    private async ensureAttemptRecord(attemptIndex: number): Promise<void> {
        if (this.attemptState) {
            return;
        }

        await this.ensureTurnRecord();
        const startedAt = Date.now();
        const startedAtText = toDbTimestamp(new Date(startedAt));

        const attempt = await createSessionTurnAttempt({
            turn_id: this.getTurnId(),
            attempt_index: attemptIndex,
            max_retries: this.maxRetries,
            status: 'streaming',
            started_at: startedAtText,
            created_at: startedAtText,
            updated_at: startedAtText,
        });
        this.attemptState = new AttemptState(attempt, startedAt);
    }

    private async finishCurrentAttempt(
        status: TurnStatus,
        errorMessage: string | null = null
    ): Promise<void> {
        if (!this.attemptState) {
            await this.ensureAttemptRecord(1);
        }

        if (!this.attemptState) {
            return;
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
        });

        // 更新本地状态缓存
        this.attemptState = new AttemptState(
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

    private async patchTurn(patch: SessionTurnUpdateData): Promise<void> {
        if (!this.turn) {
            await this.ensureTurnRecord();
        }

        if (!this.turn) {
            return;
        }

        try {
            await updateSessionTurn({
                id: this.turn.id,
                turnPatch: patch,
            });
            this.turn = {
                ...this.turn,
                ...patch,
            };
        } catch (persistError) {
            console.error('[Persister] Failed to update session turn record:', persistError);
        }
    }
}
