// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { updateModelLastUsed } from '@database/queries';
import { findModelPricing } from '@database/queries/llmMetadata';
import type { SessionTurnEntity } from '@database/types';
import { SpanStatusCode } from '@opentelemetry/api';
import { event, log } from '@services/ObservabilityService';
import { ATTR } from '@services/ObservabilityService/attributes';
import { classifyError } from '@services/ObservabilityService/errors';
import { withSpan } from '@services/ObservabilityService/tracing';

import { t } from '@/i18n';
import {
    type AttachmentIndex,
    ensurePersistedAttachmentIndex,
    getModelAttachmentCapabilities,
    getUnsupportedAttachmentTypes,
} from '@/services/AgentService/infrastructure/attachments';
import { LiveUsageTracker } from '@/services/UsageService/liveUsage';
import type { InputHistorySnapshot } from '@/types/session';

import { AiError, AiErrorCode } from '../contracts/errors';
import type { AiCallRecord } from '../contracts/protocol';
import {
    type AgentPersistenceResult,
    type AgentRequestAnalytics,
    type AgentRequestResult,
    createAgentRequestAnalytics,
} from '../infrastructure/analytics';
import { getCurrentModelLanguageContext } from '../languageContext';
import { PersistenceProjector } from '../outputs/persistence';
import { composePromptSnapshot } from '../prompt/composer';
import { buildPromptTransportMessages } from '../prompt/transport';
import type { PromptSnapshot } from '../prompt/types';
import { buildSessionTitle } from '../session/title';
import { findUnsupportedSessionAttachmentTypes } from '../session/transport';
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

/** 取消是用户主动操作，不应把 attempt span 标记为错误。 */
export function attemptSpanStatus(
    attemptResult: AttemptExecutionResult
): { code: SpanStatusCode; message: string } | undefined {
    if (attemptResult.type !== 'failed' || attemptResult.error.is(AiErrorCode.REQUEST_CANCELLED)) {
        return undefined;
    }

    return {
        code: SpanStatusCode.ERROR,
        message: attemptResult.error.code,
    };
}

/**
 * Host environment the runtime needs before it can run a turn.
 *
 * The `execution` layer consumes only these abstractions and never touches the
 * UI store, desktop notifications, or any other host implementation.
 */
export interface ConversationRuntimeEnvironment {
    reportPersistenceIssue?: (issue: RuntimePersistenceIssue) => Promise<void> | void;
}

/**
 * Persistence problems are raised through this structure to the outer output
 * layer, which decides whether to notify the user, log, or ignore them.
 */
export interface RuntimePersistenceIssue {
    phase:
        | 'attachment_prepare'
        | 'turn_start'
        | 'turn_completed'
        | 'turn_cancelled'
        | 'turn_failed'
        | 'retry_started';
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
 * Unified events emitted by the runtime.
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
    inputSnapshot?: InputHistorySnapshot;
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
 * console logs in executor.ts stay English so they line up with provider and SDK output.
 */
function buildPersistenceIssue(
    bodyKey: Parameters<typeof t>[0]
): Pick<RuntimePersistenceIssue, 'title' | 'body'> {
    return {
        title: t('agent.persistenceIssue.title'),
        body: t(bodyKey),
    };
}

/**
 * Owns the state and lifecycle of one request:
 * - resolve the model and message context for this request
 * - initialise persistence, the settings snapshot, and the start time
 * - schedule retry attempts
 * - close out on completion, failure, or cancellation
 *
 * It does not run the streaming loop itself but delegates to AiRequestExecutor.
 */
export class AiConversationRuntime {
    private readonly startedAt = Date.now();
    private requestFinalized = false;
    /** Live usage tracker for the running turn; null before it starts. */
    private liveTracker: LiveUsageTracker | null = null;
    private readonly analytics: AgentRequestAnalytics;
    private analyticsFinalized = false;
    private analyticsPersistence: AgentPersistenceResult = 'not_applicable';
    private readonly accumulatedCalls: AiCallRecord[] = [];
    private usageReportedCalls = 0;
    private requestRetryCount = 0;
    private requestModelSwitchCount = 0;
    private providerTtftMs: number | null = null;
    private analyticsErrorCode: string | null = null;

    constructor(
        private readonly executor: AiRequestExecutor,
        private readonly options: ExecuteRequestOptions
    ) {
        this.analytics = createAgentRequestAnalytics({
            requestKind: 'chat',
            surface: this.options.executionMode === 'background' ? 'other' : 'main',
        });
    }

    private async reportPersistenceIssue(issue: RuntimePersistenceIssue): Promise<void> {
        try {
            await this.options.environment?.reportPersistenceIssue?.(issue);
        } catch (error) {
            log.error('[AiConversationRuntime] Failed to deliver persistence issue:', error);
        }
    }

    /**
     * Pre-persisting attachments only unlocks extras such as hash, attachmentId,
     * and provider remote ref reuse. A failure here must not block the turn; the
     * raw files can still be sent inline.
     */
    private async prepareAttachmentsForTransport(attachments: AttachmentIndex[]): Promise<void> {
        const startedMono = performance.now();
        const results = await Promise.allSettled(
            attachments.map((attachment) => ensurePersistedAttachmentIndex(attachment))
        );

        let failed = false;
        for (const result of results) {
            if (result.status === 'fulfilled') {
                continue;
            }

            failed = true;
            log.error(
                '[AiConversationRuntime] Failed to pre-persist attachment before request:',
                result.reason
            );
            await this.reportPersistenceIssue({
                phase: 'attachment_prepare',
                ...buildPersistenceIssue('agent.persistenceIssue.attachmentPrepare'),
                error: result.reason,
            });
        }

        this.analytics.noteAttachmentPreparation({
            attachments,
            result: failed ? 'failure' : 'success',
            durationMs: performance.now() - startedMono,
            // Preparation failures are generic I/O or database errors; without a
            // typed cause the honest bucket is the fixed catch-all, never a
            // guessed specific category.
            ...(failed ? { errorCategory: 'other' as const } : {}),
        });
    }

    /**
     * Wrap the tool-approval callback so a single unique decision is recorded.
     *
     * The callback only resolves `approved: false` for both a user rejection and
     * a cancellation, so the abort signal distinguishes them without extra state.
     * The runtime has no approval timeout, so no fabricated `timeout` is sent.
     */
    private wrapToolApproval(): RequestExecutionCallbacks['requestToolApproval'] {
        const inner = this.options.requestToolApproval;
        if (!inner) {
            return undefined;
        }

        return async (payload) => {
            const startedMono = performance.now();
            let approved = false;
            try {
                approved = await inner(payload);
                return approved;
            } finally {
                this.analytics.noteApprovalResolved({
                    resolution: approved
                        ? 'approved'
                        : this.options.signal?.aborted
                          ? 'cancelled'
                          : 'rejected',
                    waitMs: performance.now() - startedMono,
                });
            }
        };
    }

    private async createRuntimeContext(): Promise<RuntimeContext> {
        const initialModel = await this.executor.getModel({
            modelId: this.options.modelId,
            providerId: this.options.providerId,
        });
        const attachments = this.options.attachments ?? [];
        const attachmentCapabilities = getModelAttachmentCapabilities(initialModel);
        const unsupportedAttachmentTypes = new Set([
            ...getUnsupportedAttachmentTypes(attachments, attachmentCapabilities),
            ...(await findUnsupportedSessionAttachmentTypes({
                sessionId: this.options.sessionId,
                capabilities: attachmentCapabilities,
            })),
        ]);
        if (unsupportedAttachmentTypes.size > 0) {
            throw new AiError(AiErrorCode.UNSUPPORTED_INPUT, {
                unsupportedAttachmentTypes: Array.from(unsupportedAttachmentTypes),
                modelId: initialModel.model_id,
                providerId: initialModel.provider_id,
            });
        }

        if (attachments.length > 0) {
            await this.prepareAttachmentsForTransport(attachments);
        }
        // The prompt snapshot is built once per turn and reused by retries,
        // tool iterations, and checkpoint resumes.
        const promptSnapshot =
            this.options.promptSnapshot ??
            (await composePromptSnapshot({
                prompt: this.options.prompt,
                attachments,
                executionMode: this.options.executionMode ?? 'foreground',
                inputSnapshot: this.options.inputSnapshot,
            }));
        const modelLanguageContext =
            promptSnapshot.modelLanguageContext ?? getCurrentModelLanguageContext();
        const baseMessages = await buildPromptTransportMessages({
            sessionId: this.options.sessionId,
            snapshot: promptSnapshot,
            attachments,
            attachmentCapabilities,
        });
        const initialCheckpoint = this.executor.createInitialCheckpoint({
            initialModel,
            baseMessages,
            modelLanguageContext,
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
            attachments,
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
                log.error('[AiConversationRuntime] Failed to record request start:', error);
                await this.reportPersistenceIssue({
                    phase: 'turn_start',
                    ...buildPersistenceIssue('agent.persistenceIssue.turnStart'),
                    error,
                });
            });

        return {
            initialCheckpoint,
            persister,
            requestStartRecordPromise,
        };
    }

    /**
     * Build the live usage tracker.
     *
     * Without pricing the cost is left unset: better to show nothing than to
     * invent a number.
     */
    private async createLiveUsageTracker(
        context: RuntimeContext
    ): Promise<LiveUsageTracker | null> {
        if (!this.options.taskId) {
            return null;
        }

        const model = context.initialCheckpoint.activeModel;

        try {
            const pricing = await findModelPricing(model.model_id);
            return new LiveUsageTracker({
                taskId: this.options.taskId,
                sessionId: context.persister.getSessionId() ?? this.options.sessionId ?? null,
                modelName: model.model_id,
                estimatedOutputCostPerMillion: pricing ? Number(pricing.outputPerMillion) : null,
            });
        } catch (error) {
            log.warn('[AiConversationRuntime] Failed to prepare live usage tracker:', error);
            return null;
        }
    }

    private shouldRetryAttempt(result: AttemptFailureResult, retryAttempt: number): boolean {
        // Retry while the error is retryable and attempts remain. Checkpoints
        // guarantee a safe resume: partial output and uncommitted tool calls
        // since the last checkpoint are not replayed, and the projector handles
        // the UI transition.
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
                durationMs: Date.now() - this.startedAt,
                outputParts: result.finalStepOutputParts,
                calls: result.calls,
                ttftMs: result.firstTtftMs,
                firstTextMs: result.firstTextMs,
                toolArgumentErrors: result.toolArgumentErrors,
                modelSwitchCount: result.modelSwitchCount,
                hitModelSwitchCeiling: result.hitModelSwitchCeiling,
                tokensUsed:
                    result.totalUsage.inputTokens +
                    result.totalUsage.outputTokens +
                    result.totalUsage.cacheReadTokens +
                    result.totalUsage.cacheWriteTokens,
            });
            this.analyticsPersistence = 'saved';
        } catch (persistError) {
            this.analyticsPersistence = 'failed';
            log.error('[AiConversationRuntime] Failed to persist completion:', persistError);
            await this.reportPersistenceIssue({
                phase: 'turn_completed',
                ...buildPersistenceIssue('agent.persistenceIssue.turnCompleted'),
                error: persistError,
            });
        }

        // Close out with the measured output tokens so the panel switches from estimate to real.
        this.liveTracker?.finish({
            outputTokens: result.totalUsage.outputTokens,
            costMicros: null,
        });
        this.liveTracker = null;

        this.requestFinalized = true;

        await updateModelLastUsed({ id: result.model.id }).catch((error) => {
            log.error('[AiConversationRuntime] Failed to update model last used:', error);
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

        await this.finalizeRequestAnalytics('success');

        return {
            model: result.model,
            response: result.response,
            reasoning: result.reasoning,
            turn: context.persister.getTurn(),
        };
    }

    /**
     * Emit the single terminal analytics event, once, for the logical request.
     *
     * The captured consent handle is reused, so the current consent is never
     * re-read; a request that began disabled stays suppressed even if it is
     * re-enabled before completion.
     */
    private async finalizeRequestAnalytics(result: AgentRequestResult): Promise<void> {
        if (this.analyticsFinalized) {
            return;
        }
        this.analyticsFinalized = true;

        try {
            await this.analytics.complete({
                result,
                retryCount: this.requestRetryCount,
                modelSwitchCount: this.requestModelSwitchCount,
                providerTtftMs: this.providerTtftMs,
                errorCode: this.analyticsErrorCode,
                persistenceResult: this.analyticsPersistence,
                calls: this.accumulatedCalls,
                usageReportedCalls: this.usageReportedCalls,
            });
        } catch (error) {
            log.error('[AiConversationRuntime] Failed to record analytics completion:', error);
        }
    }

    /**
     * Run the full request lifecycle.
     */
    async run(): Promise<ExecuteRequestResult> {
        const attributes: Record<string, string | number> = {
            [ATTR.requestModel]: this.options.modelId ?? 'unknown',
        };
        if (this.options.sessionId !== undefined) {
            attributes[ATTR.conversationId] = this.options.sessionId;
        }
        if (this.options.taskId) {
            attributes[ATTR.turnId] = this.options.taskId;
        }

        return withSpan('touchai.turn', attributes, (turnSpan) => this.runInSpan(turnSpan));
    }

    private async runInSpan(
        turnSpan: import('@opentelemetry/api').Span
    ): Promise<ExecuteRequestResult> {
        this.analytics.submit({ attachmentCount: (this.options.attachments ?? []).length });

        let context: RuntimeContext;
        try {
            context = await this.createRuntimeContext();
        } catch (error) {
            const aiError = AiError.fromError(error);
            this.analyticsErrorCode = aiError.code;
            await this.finalizeRequestAnalytics(
                aiError.is(AiErrorCode.REQUEST_CANCELLED) ? 'cancelled' : 'failure'
            );
            throw error;
        }

        let resumeCheckpoint = context.initialCheckpoint;
        const requestToolApproval = this.wrapToolApproval();

        try {
            await context.requestStartRecordPromise;

            // The panel needs usage while streaming, and pricing is static, so
            // one lookup at the start of the turn is enough; persisting later
            // uses the same data.
            this.liveTracker = await this.createLiveUsageTracker(context);
            // Heartbeat so the rate keeps being pushed during tool calls and
            // first-token waits, when no chunk arrives.
            this.liveTracker?.start();

            for (let retryAttempt = 0; retryAttempt <= MAX_REQUEST_RETRIES; retryAttempt += 1) {
                const attemptResult = await withSpan(
                    'touchai.attempt',
                    { [ATTR.attempt]: retryAttempt + 1 },
                    (attemptSpan) =>
                        this.executor.runAttempt({
                            startCheckpoint: resumeCheckpoint,
                            persister: context.persister,
                            taskId: this.options.taskId,
                            signal: this.options.signal,
                            parentSpan: attemptSpan,
                            onChunk: (chunk) => {
                                if (chunk.content) {
                                    this.analytics.noteFirstOutput();
                                }
                                this.liveTracker?.consume(chunk);
                                this.options.onChunk?.(chunk);
                            },
                            onTurnEvent: this.options.onTurnEvent,
                            requestToolApproval,
                            requestUserQuestions: this.options.requestUserQuestions,
                        }),
                    turnSpan,
                    attemptSpanStatus
                );

                this.accumulatedCalls.push(...attemptResult.calls);
                this.usageReportedCalls += attemptResult.usageReportedCalls;
                this.requestModelSwitchCount += attemptResult.modelSwitchCount;
                if (this.providerTtftMs === null && attemptResult.firstTtftMs !== null) {
                    this.providerTtftMs = attemptResult.firstTtftMs;
                }

                await context.requestStartRecordPromise;

                if (attemptResult.type === 'completed') {
                    return this.handleCompleted(context, attemptResult);
                }

                if (attemptResult.error.is(AiErrorCode.REQUEST_CANCELLED)) {
                    try {
                        await context.persister.markCancelled(attemptResult.partialOutputParts, {
                            calls: attemptResult.calls,
                            ttftMs: attemptResult.firstTtftMs,
                            firstTextMs: attemptResult.firstTextMs,
                            toolArgumentErrors: attemptResult.toolArgumentErrors,
                            modelSwitchCount: attemptResult.modelSwitchCount,
                            hitModelSwitchCeiling: attemptResult.hitModelSwitchCeiling,
                            errorCode: attemptResult.error.code,
                        });
                        this.analyticsPersistence = 'saved';
                    } catch (persistError) {
                        this.analyticsPersistence = 'failed';
                        log.error(
                            '[AiConversationRuntime] Failed to persist cancellation:',
                            persistError
                        );
                        await this.reportPersistenceIssue({
                            phase: 'turn_cancelled',
                            ...buildPersistenceIssue('agent.persistenceIssue.turnCancelled'),
                            error: persistError,
                        });
                    }

                    this.liveTracker?.stop();
                    this.liveTracker = null;
                    this.requestFinalized = true;
                    if (this.options.taskId) {
                        this.options.onTurnEvent?.({
                            type: 'task_cancelled',
                            taskId: this.options.taskId,
                            turnId: context.persister.getTurn()?.id ?? null,
                        });
                    }
                    await this.finalizeRequestAnalytics('cancelled');
                    throw attemptResult.error;
                }

                if (this.shouldRetryAttempt(attemptResult, retryAttempt)) {
                    const nextAttempt = retryAttempt + 1;
                    this.requestRetryCount += 1;
                    // A retry resumes from the last safe checkpoint rather than the start of the turn.
                    resumeCheckpoint = attemptResult.resumeCheckpoint;
                    try {
                        await context.persister.beginNextAttempt(
                            attemptResult.error.message,
                            resumeCheckpoint,
                            {
                                calls: attemptResult.calls,
                                ttftMs: attemptResult.firstTtftMs,
                                firstTextMs: attemptResult.firstTextMs,
                                toolArgumentErrors: attemptResult.toolArgumentErrors,
                                modelSwitchCount: attemptResult.modelSwitchCount,
                                hitModelSwitchCeiling: attemptResult.hitModelSwitchCeiling,
                            }
                        );
                    } catch (persistError) {
                        log.error(
                            '[AiConversationRuntime] Failed to persist retry attempt:',
                            persistError
                        );
                        await this.reportPersistenceIssue({
                            phase: 'retry_started',
                            ...buildPersistenceIssue('agent.persistenceIssue.retryStarted'),
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
                    event('agent.retry.scheduled', {
                        [ATTR.attempt]: nextAttempt,
                        [ATTR.errorCode]: classifyError(attemptResult.error),
                    });
                    await waitForRetryDelay(getRetryDelayMs(nextAttempt), this.options.signal);
                    continue;
                }

                try {
                    await context.persister.markFailed(
                        attemptResult.error.message,
                        attemptResult.partialOutputParts,
                        {
                            calls: attemptResult.calls,
                            ttftMs: attemptResult.firstTtftMs,
                            firstTextMs: attemptResult.firstTextMs,
                            toolArgumentErrors: attemptResult.toolArgumentErrors,
                            modelSwitchCount: attemptResult.modelSwitchCount,
                            hitModelSwitchCeiling: attemptResult.hitModelSwitchCeiling,
                            errorCode: attemptResult.error.code,
                            retryScope: resumeCheckpoint.iteration > 0 ? 'checkpoint' : 'restart',
                        }
                    );
                    this.analyticsPersistence = 'saved';
                } catch (persistError) {
                    this.analyticsPersistence = 'failed';
                    log.error('[AiConversationRuntime] Failed to persist failure:', persistError);
                    await this.reportPersistenceIssue({
                        phase: 'turn_failed',
                        ...buildPersistenceIssue('agent.persistenceIssue.turnFailed'),
                        error: persistError,
                    });
                }

                this.liveTracker?.stop();
                this.liveTracker = null;
                this.requestFinalized = true;
                if (this.options.taskId) {
                    this.options.onTurnEvent?.({
                        type: 'task_failed',
                        taskId: this.options.taskId,
                        turnId: context.persister.getTurn()?.id ?? null,
                        error: attemptResult.error.message,
                    });
                }
                this.analyticsErrorCode = attemptResult.error.code;
                await this.finalizeRequestAnalytics('failure');
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
                        this.analyticsPersistence = 'saved';
                    } catch (persistError) {
                        this.analyticsPersistence = 'failed';
                        log.error(
                            '[AiConversationRuntime] Failed to persist cancellation:',
                            persistError
                        );
                        await this.reportPersistenceIssue({
                            phase: 'turn_cancelled',
                            ...buildPersistenceIssue('agent.persistenceIssue.turnCancelled'),
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
                        this.analyticsPersistence = 'saved';
                    } catch (persistError) {
                        this.analyticsPersistence = 'failed';
                        log.error(
                            '[AiConversationRuntime] Failed to persist failure:',
                            persistError
                        );
                        await this.reportPersistenceIssue({
                            phase: 'turn_failed',
                            ...buildPersistenceIssue('agent.persistenceIssue.turnFailed'),
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

            this.analyticsErrorCode = aiError.code;
            await this.finalizeRequestAnalytics(
                aiError.is(AiErrorCode.REQUEST_CANCELLED) ? 'cancelled' : 'failure'
            );
            throw aiError;
        }
    }
}
