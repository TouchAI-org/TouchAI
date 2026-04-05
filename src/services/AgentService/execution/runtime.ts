// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { updateModelLastUsed } from '@database/queries';
import type { SessionTurnEntity } from '@database/types';

import type { AttachmentIndex } from '@/services/AgentService/infrastructure/attachments';

import { AiError, AiErrorCode } from '../contracts/errors';
import { PersistenceProjector } from '../outputs/persistence';
import { composePromptSnapshot } from '../prompt/composer';
import { buildPromptTransportMessages } from '../prompt/transport';
import type { PromptSnapshot } from '../prompt/types';
import { buildSessionTitle } from '../session/title';
import type { TaskExecutionMode } from '../task/types';
import {
    AiRequestExecutor,
    type AttemptCheckpoint,
    type AttemptExecutionResult,
    type AttemptFailureResult,
    type ModelWithProvider,
    type RequestExecutionCallbacks,
} from './executor';
import {
    getRetryDelayMs,
    MAX_REQUEST_RETRIES,
    shouldRetryRequestFailure,
    waitForRetryDelay,
} from './retry';

/**
 * 运行时在真正执行 turn 之前需要的宿主环境。
 *
 * `execution` 层只消费这些抽象依赖，不直接触碰 UI store、
 * 桌面通知或其他宿主实现。
 */
export interface ConversationRuntimeEnvironment {
    maxIterations: number;
    reportPersistenceIssue?: (issue: RuntimePersistenceIssue) => Promise<void> | void;
}

/**
 * 持久化相关问题会通过这个结构上抛给外层 output，
 * 由外层决定是否通知用户、写日志或静默忽略。
 */
export interface RuntimePersistenceIssue {
    phase: 'turn_start' | 'turn_completed' | 'turn_cancelled' | 'turn_failed' | 'retry_started';
    title: string;
    body: string;
    error: unknown;
}

export interface TaskModelSummary {
    modelDbId: number | null;
    providerId: number;
    providerName: string;
    modelId: string;
    modelName: string;
}

export function summarizeTaskModel(model: ModelWithProvider): TaskModelSummary {
    return {
        modelDbId: model.id,
        providerId: model.provider_id,
        providerName: model.provider_name,
        modelId: model.model_id,
        modelName: model.name,
    };
}

/**
 * 运行时内部统一事件。
 */
export type TurnEvent =
    | {
          type: 'task_started';
          taskId: string;
          sessionId: number | null;
          turnId: number | null;
          executionMode: TaskExecutionMode;
          model: TaskModelSummary;
      }
    | {
          type: 'prompt_snapshot_ready';
          taskId: string;
          snapshot: PromptSnapshot;
      }
    | {
          type: 'checkpoint_committed';
          taskId: string;
          checkpoint: AttemptCheckpoint;
      }
    | {
          type: 'retry_scheduled';
          taskId: string;
          attempt: number;
          maxRetries: number;
          reason: string;
          checkpoint: AttemptCheckpoint;
      }
    | {
          type: 'task_completed';
          taskId: string;
          turnId: number | null;
          model: TaskModelSummary;
          response: string;
          reasoning: string;
      }
    | {
          type: 'task_failed';
          taskId: string;
          turnId: number | null;
          error: string;
      }
    | {
          type: 'task_cancelled';
          taskId: string;
          turnId: number | null;
      };

export interface ExecuteRequestOptions extends RequestExecutionCallbacks {
    prompt: string;
    sessionId?: number;
    modelId?: string;
    providerId?: number;
    attachments?: AttachmentIndex[];
    executionMode?: TaskExecutionMode;
    promptSnapshot?: PromptSnapshot;
    environment?: ConversationRuntimeEnvironment;
}

export interface ExecuteRequestResult {
    model: ModelWithProvider;
    response: string;
    reasoning: string;
    turn: SessionTurnEntity | null;
}

interface RuntimeContext {
    initialCheckpoint: AttemptCheckpoint;
    persister: PersistenceProjector;
    requestStartRecordPromise: Promise<void>;
}

/**
 * 这里的持久化异常标题/正文会直接展示给用户，因此统一使用中文。
 * executor.ts 中的 console 日志继续保留英文，便于对齐 provider / SDK 调试信息。
 */
const PERSISTENCE_ISSUE_TITLE = '数据库错误';

/**
 * 管理一次请求的运行时状态与生命周期：
 * - 解析本次请求使用的模型与消息上下文
 * - 初始化持久化、设置快照与开始时间
 * - 调度多次 retry attempt
 * - 统一处理完成、失败、取消收尾
 *
 * 它不直接执行模型流式 loop，而是把执行工作委托给 AiRequestExecutor。
 */
export class AiConversationRuntime {
    private readonly startedAt = Date.now();
    private requestFinalized = false;

    constructor(
        private readonly executor: AiRequestExecutor,
        private readonly options: ExecuteRequestOptions
    ) {}

    private getRuntimeEnvironment(): ConversationRuntimeEnvironment {
        return {
            maxIterations: this.options.environment?.maxIterations ?? 10,
            reportPersistenceIssue: this.options.environment?.reportPersistenceIssue,
        };
    }

    private async reportPersistenceIssue(issue: RuntimePersistenceIssue): Promise<void> {
        try {
            await this.options.environment?.reportPersistenceIssue?.(issue);
        } catch (error) {
            console.error('[AiConversationRuntime] Failed to deliver persistence issue:', error);
        }
    }

    private async createRuntimeContext(): Promise<RuntimeContext> {
        const initialModel = await this.executor.getModel({
            modelId: this.options.modelId,
            providerId: this.options.providerId,
        });
        // prompt 快照在整个 turn 生命周期内只生成一次。
        // 后续 retry、tool iteration、checkpoint resume 都必须复用它。
        const promptSnapshot =
            this.options.promptSnapshot ??
            composePromptSnapshot({
                prompt: this.options.prompt,
                attachments: this.options.attachments,
                executionMode: this.options.executionMode ?? 'foreground',
            });
        const baseMessages = await buildPromptTransportMessages({
            sessionId: this.options.sessionId,
            snapshot: promptSnapshot,
            attachments: this.options.attachments ?? [],
            supportsAttachments: initialModel.attachment === 1,
        });
        const initialCheckpoint = this.executor.createInitialCheckpoint({
            initialModel,
            baseMessages,
        });

        if (this.options.taskId) {
            this.options.onTurnEvent?.({
                type: 'prompt_snapshot_ready',
                taskId: this.options.taskId,
                snapshot: promptSnapshot,
            });
        }

        const persister = new PersistenceProjector({
            prompt: this.options.prompt,
            attachments: this.options.attachments ?? [],
            model: initialModel,
            sessionId: this.options.sessionId ?? null,
            taskId: this.options.taskId ?? crypto.randomUUID(),
            executionMode: this.options.executionMode ?? 'foreground',
            promptSnapshot,
            maxRetries: MAX_REQUEST_RETRIES,
            buildSessionTitle,
        });

        const requestStartRecordPromise = persister
            .recordTurnStart(initialCheckpoint)
            .then(() => {
                if (!this.options.taskId) {
                    return;
                }

                this.options.onTurnEvent?.({
                    type: 'task_started',
                    taskId: this.options.taskId,
                    sessionId: persister.getSessionId(),
                    turnId: persister.getTurn()?.id ?? null,
                    executionMode: this.options.executionMode ?? 'foreground',
                    model: summarizeTaskModel(initialModel),
                });
            })
            .catch(async (error) => {
                console.error('[AiConversationRuntime] Failed to record request start:', error);
                await this.reportPersistenceIssue({
                    phase: 'turn_start',
                    title: PERSISTENCE_ISSUE_TITLE,
                    body: '保存会话轮次失败，对话将继续但可能无法保存。',
                    error,
                });
            });

        return {
            initialCheckpoint,
            persister,
            requestStartRecordPromise,
        };
    }

    private shouldRetryAttempt(result: AttemptFailureResult, retryAttempt: number): boolean {
        // 只要错误类型可重试且重试次数未耗尽，即允许重试。
        // checkpoint 机制已保证从安全状态恢复——自上次 checkpoint 以来的部分流式输出
        // 和未提交的工具调用不会被重放，由投影器负责处理 UI 侧的内容过渡。
        return (
            retryAttempt < MAX_REQUEST_RETRIES &&
            shouldRetryRequestFailure(result.error, result.providerErrorDetails)
        );
    }

    private emitRetryEvent(
        reason: string,
        nextAttempt: number,
        checkpoint: AttemptCheckpoint,
        failure: Pick<
            AttemptFailureResult,
            'hasVisibleOutputSinceCheckpoint' | 'hasToolActivitySinceCheckpoint'
        >
    ): void {
        this.options.onChunk?.({
            content: '',
            done: false,
            toolEvent: {
                type: 'request_retry',
                attempt: nextAttempt,
                maxRetries: MAX_REQUEST_RETRIES,
                reason,
                retryScope: checkpoint.iteration > 0 ? 'checkpoint' : 'restart',
                resumeFromIteration: checkpoint.iteration,
                discardVisibleOutputSinceCheckpoint: failure.hasVisibleOutputSinceCheckpoint,
                discardToolActivitySinceCheckpoint: failure.hasToolActivitySinceCheckpoint,
            },
        });
    }

    private async handleCompleted(
        context: RuntimeContext,
        result: Extract<AttemptExecutionResult, { type: 'completed' }>
    ): Promise<ExecuteRequestResult> {
        try {
            await context.persister.markCompleted({
                response: result.response,
                durationMs: Date.now() - this.startedAt,
            });
        } catch (persistError) {
            console.error('[AiConversationRuntime] Failed to persist completion:', persistError);
            await this.reportPersistenceIssue({
                phase: 'turn_completed',
                title: PERSISTENCE_ISSUE_TITLE,
                body: '保存会话完成状态失败，对话将继续但可能无法保存。',
                error: persistError,
            });
        }

        this.requestFinalized = true;

        await updateModelLastUsed({ id: result.model.id }).catch((error) => {
            console.error('[AiConversationRuntime] Failed to update model last used:', error);
        });

        if (this.options.taskId) {
            this.options.onTurnEvent?.({
                type: 'task_completed',
                taskId: this.options.taskId,
                turnId: context.persister.getTurn()?.id ?? null,
                model: summarizeTaskModel(result.model),
                response: result.response,
                reasoning: result.reasoning,
            });
        }

        return {
            model: result.model,
            response: result.response,
            reasoning: result.reasoning,
            turn: context.persister.getTurn(),
        };
    }

    /**
     * 执行完整请求生命周期。
     */
    async run(): Promise<ExecuteRequestResult> {
        const context = await this.createRuntimeContext();
        const runtimeEnvironment = this.getRuntimeEnvironment();
        let resumeCheckpoint = context.initialCheckpoint;

        try {
            for (let retryAttempt = 0; retryAttempt <= MAX_REQUEST_RETRIES; retryAttempt += 1) {
                const attemptResult = await this.executor.runAttempt({
                    startCheckpoint: resumeCheckpoint,
                    maxIterations: runtimeEnvironment.maxIterations,
                    persister: context.persister,
                    taskId: this.options.taskId,
                    signal: this.options.signal,
                    onChunk: this.options.onChunk,
                    onTurnEvent: this.options.onTurnEvent,
                    requestToolApproval: this.options.requestToolApproval,
                });

                await context.requestStartRecordPromise;

                if (attemptResult.type === 'completed') {
                    return this.handleCompleted(context, attemptResult);
                }

                if (attemptResult.error.is(AiErrorCode.REQUEST_CANCELLED)) {
                    try {
                        await context.persister.markCancelled(attemptResult.response);
                    } catch (persistError) {
                        console.error(
                            '[AiConversationRuntime] Failed to persist cancellation:',
                            persistError
                        );
                        await this.reportPersistenceIssue({
                            phase: 'turn_cancelled',
                            title: PERSISTENCE_ISSUE_TITLE,
                            body: '保存会话取消状态失败，对话记录可能不完整。',
                            error: persistError,
                        });
                    }
                    this.requestFinalized = true;
                    if (this.options.taskId) {
                        this.options.onTurnEvent?.({
                            type: 'task_cancelled',
                            taskId: this.options.taskId,
                            turnId: context.persister.getTurn()?.id ?? null,
                        });
                    }
                    throw attemptResult.error;
                }

                if (this.shouldRetryAttempt(attemptResult, retryAttempt)) {
                    const nextAttempt = retryAttempt + 1;
                    // 重试不是总从整轮开头开始，而是从最近一次安全 checkpoint 恢复。
                    resumeCheckpoint = attemptResult.resumeCheckpoint;
                    try {
                        await context.persister.beginNextAttempt(
                            attemptResult.error.message,
                            resumeCheckpoint
                        );
                    } catch (persistError) {
                        console.error(
                            '[AiConversationRuntime] Failed to persist retry attempt:',
                            persistError
                        );
                        await this.reportPersistenceIssue({
                            phase: 'retry_started',
                            title: PERSISTENCE_ISSUE_TITLE,
                            body: '保存重试检查点失败，但本轮仍会继续重试。',
                            error: persistError,
                        });
                    }
                    if (this.options.taskId) {
                        this.options.onTurnEvent?.({
                            type: 'retry_scheduled',
                            taskId: this.options.taskId,
                            attempt: nextAttempt,
                            maxRetries: MAX_REQUEST_RETRIES,
                            reason: attemptResult.error.message,
                            checkpoint: resumeCheckpoint,
                        });
                    }
                    this.emitRetryEvent(
                        attemptResult.error.message,
                        nextAttempt,
                        resumeCheckpoint,
                        attemptResult
                    );
                    await waitForRetryDelay(getRetryDelayMs(nextAttempt), this.options.signal);
                    continue;
                }

                try {
                    await context.persister.markFailed(
                        attemptResult.error.message,
                        attemptResult.response
                    );
                } catch (persistError) {
                    console.error(
                        '[AiConversationRuntime] Failed to persist failure:',
                        persistError
                    );
                    await this.reportPersistenceIssue({
                        phase: 'turn_failed',
                        title: PERSISTENCE_ISSUE_TITLE,
                        body: '保存会话失败状态失败，对话记录可能不完整。',
                        error: persistError,
                    });
                }
                this.requestFinalized = true;
                if (this.options.taskId) {
                    this.options.onTurnEvent?.({
                        type: 'task_failed',
                        taskId: this.options.taskId,
                        turnId: context.persister.getTurn()?.id ?? null,
                        error: attemptResult.error.message,
                    });
                }
                throw attemptResult.error;
            }

            throw new AiError(AiErrorCode.UNKNOWN, undefined, '请求重试耗尽后未返回结果');
        } catch (error) {
            const aiError = AiError.fromError(error);
            await context.requestStartRecordPromise;

            if (!this.requestFinalized) {
                if (aiError.is(AiErrorCode.REQUEST_CANCELLED)) {
                    try {
                        await context.persister.markCancelled();
                    } catch (persistError) {
                        console.error(
                            '[AiConversationRuntime] Failed to persist cancellation:',
                            persistError
                        );
                        await this.reportPersistenceIssue({
                            phase: 'turn_cancelled',
                            title: PERSISTENCE_ISSUE_TITLE,
                            body: '保存会话取消状态失败，对话记录可能不完整。',
                            error: persistError,
                        });
                    }
                    if (this.options.taskId) {
                        this.options.onTurnEvent?.({
                            type: 'task_cancelled',
                            taskId: this.options.taskId,
                            turnId: context.persister.getTurn()?.id ?? null,
                        });
                    }
                } else {
                    try {
                        await context.persister.markFailed(aiError.message);
                    } catch (persistError) {
                        console.error(
                            '[AiConversationRuntime] Failed to persist failure:',
                            persistError
                        );
                        await this.reportPersistenceIssue({
                            phase: 'turn_failed',
                            title: PERSISTENCE_ISSUE_TITLE,
                            body: '保存会话失败状态失败，对话记录可能不完整。',
                            error: persistError,
                        });
                    }
                    if (this.options.taskId) {
                        this.options.onTurnEvent?.({
                            type: 'task_failed',
                            taskId: this.options.taskId,
                            turnId: context.persister.getTurn()?.id ?? null,
                            error: aiError.message,
                        });
                    }
                }
            }

            throw aiError;
        }
    }
}
