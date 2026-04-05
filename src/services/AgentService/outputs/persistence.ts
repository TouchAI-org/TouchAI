// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

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

import {
    type AttachmentIndex,
    ensurePersistedAttachmentIndex,
} from '@/services/AgentService/infrastructure/attachments';
import { toDbTimestamp } from '@/utils/date';

import type { AiContentPart, AiMessage } from '../contracts/protocol';
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
type PersistedCheckpointModel = Pick<
    AttemptCheckpoint['activeModel'],
    | 'id'
    | 'provider_id'
    | 'provider_name'
    | 'provider_driver'
    | 'model_id'
    | 'name'
    | 'attachment'
    | 'reasoning'
    | 'tool_call'
    | 'context_limit'
    | 'output_limit'
>;

type PersistedAiContentPart =
    | Extract<AiContentPart, { type: 'text' }>
    | { type: 'image'; mimeType: string; redacted: true }
    | { type: 'file'; name: string; isBinary: boolean; redacted: true }
    | Extract<AiContentPart, { type: 'tool_use' }>
    | Extract<AiContentPart, { type: 'tool_result' }>;

interface PersistedAiMessage extends Omit<AiMessage, 'content'> {
    content: string | PersistedAiContentPart[];
}

interface PersistedAttemptCheckpoint {
    activeModel: PersistedCheckpointModel;
    messages: PersistedAiMessage[];
    response: string;
    reasoning: string;
    iteration: number;
    modelSwitchCount: number;
    executedBuiltInToolIds: AttemptCheckpoint['executedBuiltInToolIds'];
}

function sanitizeCheckpointModel(
    model: AttemptCheckpoint['activeModel']
): PersistedCheckpointModel {
    return {
        id: model.id,
        provider_id: model.provider_id,
        provider_name: model.provider_name,
        provider_driver: model.provider_driver,
        model_id: model.model_id,
        name: model.name,
        attachment: model.attachment,
        reasoning: model.reasoning,
        tool_call: model.tool_call,
        context_limit: model.context_limit,
        output_limit: model.output_limit,
    };
}

function sanitizeContentPart(part: AiContentPart): PersistedAiContentPart {
    switch (part.type) {
        case 'image':
            return {
                type: 'image',
                mimeType: part.mimeType,
                redacted: true,
            };
        case 'file':
            return {
                type: 'file',
                name: part.name,
                isBinary: part.isBinary,
                redacted: true,
            };
        default:
            return part;
    }
}

function sanitizeMessage(message: AiMessage): PersistedAiMessage {
    return {
        ...message,
        content:
            typeof message.content === 'string'
                ? message.content
                : message.content.map((part) => sanitizeContentPart(part)),
    };
}

function serializeCheckpoint(checkpoint: AttemptCheckpoint): string {
    // checkpoint_json 仅用于诊断与恢复参考，不应重复落库密钥或附件正文。
    const persisted: PersistedAttemptCheckpoint = {
        activeModel: sanitizeCheckpointModel(checkpoint.activeModel),
        messages: checkpoint.messages.map((message) => sanitizeMessage(message)),
        response: checkpoint.response,
        reasoning: checkpoint.reasoning,
        iteration: checkpoint.iteration,
        modelSwitchCount: checkpoint.modelSwitchCount,
        executedBuiltInToolIds: checkpoint.executedBuiltInToolIds,
    };
    return JSON.stringify(persisted);
}

export class PersistenceProjector {
    private readonly prompt: string;
    private readonly attachments: AttachmentIndex[];
    private readonly model: PersistenceProjectorModel;
    private readonly taskId: string;
    private readonly executionMode: TaskExecutionMode;
    private readonly promptSnapshot: PromptSnapshot;
    private readonly maxRetries: number;
    private readonly buildSessionTitle: (prompt: string) => string;

    private sessionId: number | null;
    private sessionCreationPromise: Promise<number> | null;

    private userMessageId: number | null;
    private assistantMessageId: number | null;
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
        await this.ensureAttemptRecord(1, initialCheckpoint);
    }

    /**
     * 当前轮次成功阶段：记录助手回复并更新状态。
     */
    async markCompleted(options: CompleteTurnOptions): Promise<void> {
        try {
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
        } catch (error) {
            console.error('[PersistenceProjector] Failed to mark turn as completed:', error);
            throw error;
        }
    }

    /**
     * 当前轮次失败阶段：更新最终失败状态和错误信息。
     */
    async markFailed(errorMessage: string, partialResponse?: string): Promise<void> {
        try {
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
        } catch (error) {
            console.error('[PersistenceProjector] Failed to mark turn as failed:', error);
            throw error;
        }
    }

    /**
     * 当前轮次取消阶段：更新取消状态。
     */
    async markCancelled(partialResponse?: string): Promise<void> {
        try {
            if (partialResponse?.trim() && !this.assistantMessageId) {
                this.assistantMessageId = await this.persistMessage('assistant', partialResponse);
            }

            await this.finishCurrentAttempt('cancelled', 'Cancelled by user');
            await this.patchTurn({
                status: 'cancelled',
                error_message: 'Cancelled by user',
                response_message_id: this.assistantMessageId,
                duration_ms: this.getTurnDurationMs(),
            });
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
            await this.finishCurrentAttempt('failed', errorMessage);

            const nextAttemptIndex = (this.attemptState?.entity.attempt_index ?? 0) + 1;
            const startedAt = Date.now();
            const startedAtText = toDbTimestamp(new Date(startedAt));
            const nextAttempt = await createSessionTurnAttempt({
                turn_id: this.getTurnId(),
                attempt_index: nextAttemptIndex,
                max_retries: this.maxRetries,
                status: 'streaming',
                checkpoint_json: serializeCheckpoint(checkpoint),
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

    /**
     * 持久化工具调用消息。
     */
    async persistToolCallMessage(text?: string): Promise<number> {
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
    ): Promise<number> {
        return this.persistMessage('tool_result', result, toolLogId, toolLogKind);
    }

    async persistCheckpoint(checkpoint: AttemptCheckpoint): Promise<void> {
        if (!this.attemptState) {
            return;
        }

        await updateSessionTurnAttempt({
            id: this.attemptState.entity.id,
            attemptPatch: {
                checkpoint_json: serializeCheckpoint(checkpoint),
            },
        });

        this.attemptState = new AttemptState(
            {
                ...this.attemptState.entity,
                checkpoint_json: serializeCheckpoint(checkpoint),
            },
            this.attemptState.startedAtMs
        );
    }

    private async ensureSessionId(): Promise<number> {
        if (this.sessionId) {
            return this.sessionId;
        }

        if (this.sessionCreationPromise) {
            return this.sessionCreationPromise;
        }

        // 并发写入可能同时触发懒创建，这里用单实例 Promise 锁保证只落一条 session。
        const sessionCreationPromise = createSession({
            session_id: crypto.randomUUID(),
            title: this.buildSessionTitle(this.prompt),
            model: this.model.model_id,
            provider_id: this.model.provider_id,
        }).then((session) => {
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
            console.error('[PersistenceProjector] Failed to sync session identity:', error);
        }
    }

    private async persistMessage(
        role: MessageRole,
        content: string,
        toolLogId?: number | null,
        toolLogKind?: ToolLogKind | null,
        attachments: AttachmentIndex[] = []
    ): Promise<number> {
        const sessionId = await this.ensureSessionId();

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
            task_id: this.taskId,
            execution_mode: this.executionMode,
            prompt_snapshot_json: JSON.stringify(this.promptSnapshot),
            prompt_message_id: this.userMessageId,
            response_message_id: null, // 轮次开始时还没有助手回复
            status: 'streaming',
        });
        this.turnStartedAtMs = startedAt;
    }

    private async ensureAttemptRecord(
        attemptIndex: number,
        checkpoint: AttemptCheckpoint
    ): Promise<void> {
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
            checkpoint_json: serializeCheckpoint(checkpoint),
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
            console.error(
                '[PersistenceProjector] Failed to update session turn record:',
                persistError
            );
        }
    }
}
