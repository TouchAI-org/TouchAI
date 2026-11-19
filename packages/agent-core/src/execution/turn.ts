import type { AiMessage, AiToolCall } from '@touchai/models/contracts';

import {
    snapshotCheckpoint,
    snapshotMessages,
    snapshotParts,
    snapshotValue,
} from '../checkpoints/snapshot';
import { ContextWindow } from '../context/window';
import type {
    AgentCheckpoint,
    AgentEvent,
    AgentHost,
    AgentPreparedTurn,
    AgentResult,
    AgentScope,
    AgentStartInput,
    AgentTerminal,
} from '../contracts';
import { AgentError } from '../contracts/agent';
import type { AgentPersistence } from '../contracts/host';
import type { AgentToolOutcome, AgentToolResult, AgentToolScope } from '../contracts/tool';
import { assemblePrompt } from '../prompt/assembly';
import { TaskDecisions } from '../task/decisions';
import { classifyFailure, MAX_REQUEST_RETRIES, throwIfCancelled, waitForRetry } from './retry';
import type { ExecutionCursor, ModelStep } from './step';
import { callsUsage, consumeStep } from './step';

const MAX_MODEL_SWITCHES = 4;
const MAX_SKILL_ACTIVATIONS = 16;

function freezeTurn(input: AgentPreparedTurn): AgentPreparedTurn {
    return Object.freeze({
        ...input,
        model: snapshotValue(input.model),
        messages: snapshotMessages(input.messages),
        tools: Object.freeze({
            declarations: snapshotValue([...input.tools.declarations]),
            execute: input.tools.execute.bind(input.tools),
        }),
        stream: input.stream.bind(input),
        release: input.release.bind(input),
        recovery: input.recovery ? snapshotCheckpoint(input.recovery) : undefined,
        promptFragments: input.promptFragments ? snapshotValue(input.promptFragments) : undefined,
        pendingMessages: input.pendingMessages
            ? Object.freeze({
                  hasImmediate: input.pendingMessages.hasImmediate.bind(input.pendingMessages),
                  deliver: input.pendingMessages.deliver.bind(input.pendingMessages),
              })
            : undefined,
    });
}

async function barrier<T>(action: () => Promise<T>): Promise<T> {
    try {
        return await action();
    } catch (cause) {
        throw new AgentError('PERSISTENCE_FAILED', false, { cause });
    }
}

function toolMessage(outcome: AgentToolOutcome): AiMessage {
    return {
        role: 'tool',
        content: outcome.persistedContent ?? outcome.persistedResult ?? outcome.result,
        name: outcome.call.name,
        tool_call_id: outcome.call.id,
        isError: outcome.isError,
    };
}

function uncertain(call: AiToolCall, error: unknown): AgentToolOutcome {
    const reported = (
        typeof error === 'object' && error !== null
            ? (error as { outcome?: Partial<AgentToolResult> })
            : {}
    ).outcome;
    return {
        call,
        result: reported?.result ?? 'Tool effect could not be confirmed',
        isError: true,
        sideEffect: reported?.sideEffect ?? 'unknown',
    };
}

export class TurnExecution {
    private readonly startedAt = Date.now();
    private active: AgentPreparedTurn | null = null;
    private readonly allCalls: AgentResult['calls'] = [];
    private skillActivationAttempts = 0;
    private turnKey: string | null = null;

    constructor(
        private readonly host: AgentHost,
        private readonly input: AgentStartInput,
        private readonly taskId: string,
        private readonly signal: AbortSignal,
        private readonly decisions: TaskDecisions,
        private readonly emit: (event: AgentEvent) => void,
        private readonly context: ContextWindow,
        private readonly cacheKey: string,
        private readonly cancelTask: () => void
    ) {}

    async run(): Promise<AgentResult> {
        const initialScope = this.scope(1, crypto.randomUUID(), 0);
        let persistence: AgentPersistence | undefined;
        let cursor: ExecutionCursor | undefined;
        let finalSaved = false;
        let currentScope = initialScope;
        let nextAttemptScope = initialScope;
        try {
            throwIfCancelled(this.signal);
            this.active = freezeTurn(
                await this.host.prepareTurn(this.input, {
                    taskId: this.taskId,
                    signal: this.signal,
                    modelSwitchCount: 0,
                })
            );
            throwIfCancelled(this.signal);
            const messages = snapshotMessages(this.active.messages);
            const privateContents = new Map<number, AiMessage['content']>();
            if (this.active.promptFragments) {
                const prompt = assemblePrompt(this.active.promptFragments);
                if (messages[0]?.role !== 'system')
                    messages.unshift({ role: 'system', content: '' });
                // The host supplies the durable snapshot; live instructions are transport-only.
                privateContents.set(0, prompt);
            }
            let checkpoint: AgentCheckpoint = this.active.recovery
                ? snapshotCheckpoint(this.active.recovery)
                : {
                      modelKey: this.active.model.key,
                      messages,
                      response: '',
                      reasoning: '',
                      iteration: 0,
                      modelSwitchCount: 0,
                      outputParts: [],
                  };
            persistence = this.host.persistence(
                { ...this.input, taskId: this.taskId },
                this.active.model
            );
            const started = await barrier(() => persistence!.start(checkpoint, initialScope));
            const conversationKey = started.conversationKey ?? this.input.conversationKey;
            this.turnKey = started.turnKey ?? null;
            if (started.currentUserOrigin) {
                const index = checkpoint.messages.length - 1;
                if (checkpoint.messages[index]?.role === 'user')
                    checkpoint.messages[index] = {
                        ...checkpoint.messages[index]!,
                        origin: started.currentUserOrigin,
                    };
            }
            this.emit({
                type: 'task_started',
                taskId: this.taskId,
                conversationKey: conversationKey ?? null,
                turnKey: this.turnKey,
                modelKey: this.active.model.key,
            });
            for (let attempt = 0; attempt <= MAX_REQUEST_RETRIES; attempt++) {
                const scope = nextAttemptScope;
                currentScope = scope;
                cursor = {
                    ...snapshotCheckpoint(checkpoint),
                    currentParts: [],
                    privateContents,
                    calls: [],
                    toolArgumentErrors: 0,
                    hasVisibleOutput: false,
                    hasToolActivity: false,
                };
                this.decisions.begin(scope.attemptToken);
                this.emit({
                    type: 'attempt_started',
                    taskId: this.taskId,
                    attemptToken: scope.attemptToken,
                    attempt: attempt + 1,
                });
                let failure: AgentError | undefined;
                try {
                    while (true) {
                        throwIfCancelled(this.signal);
                        const stepScope = { ...scope, iteration: cursor.iteration };
                        const step = await consumeStep(
                            cursor,
                            this.active,
                            stepScope,
                            persistence,
                            this.context,
                            `${this.cacheKey}:${conversationKey ?? this.taskId}`,
                            this.emit,
                            () => {
                                checkpoint = {
                                    ...checkpoint,
                                    messages: snapshotMessages(cursor!.messages),
                                };
                                this.emit({
                                    type: 'checkpoint_committed',
                                    taskId: this.taskId,
                                    checkpoint: snapshotCheckpoint(checkpoint),
                                });
                            }
                        );
                        if (!step.calls.length && !step.steered) break;
                        if (step.steered) {
                            if (!persistence.assistant) throw new AgentError('PERSISTENCE_FAILED');
                            if (step.parts.length) {
                                const origin = await barrier(() =>
                                    persistence!.assistant!(step.parts, stepScope)
                                );
                                cursor.messages.push({
                                    role: 'assistant',
                                    content: step.parts.map((part) => ({
                                        type: part.type,
                                        text: part.content,
                                        ...(part.providerOptions
                                            ? { providerOptions: part.providerOptions }
                                            : {}),
                                    })),
                                    ...(origin ? { origin } : {}),
                                });
                            }
                            cursor.currentParts = [];
                        } else await this.tools(cursor, step, stepScope, persistence);
                        throwIfCancelled(this.signal);
                        const injected = await this.active.pendingMessages?.deliver(stepScope);
                        if (injected?.messages.length) {
                            const offset = cursor.messages.length;
                            cursor.messages.push(...snapshotMessages(injected.messages));
                            for (const entry of injected.privateContents ?? [])
                                cursor.privateContents.set(offset + entry.index, entry.content);
                        } else if (step.steered) break;
                        cursor.iteration++;
                        const candidate = snapshotCheckpoint(cursor);
                        await barrier(() => persistence!.checkpoint(candidate, stepScope));
                        checkpoint = candidate;
                        cursor.hasVisibleOutput = false;
                        cursor.hasToolActivity = false;
                        this.emit({
                            type: 'checkpoint_committed',
                            taskId: this.taskId,
                            checkpoint: snapshotCheckpoint(checkpoint),
                        });
                    }
                    if (!cursor.response.trim() && !cursor.reasoning.trim())
                        throw new AgentError('EMPTY_RESPONSE', true);
                } catch (error) {
                    failure = classifyFailure(error, this.signal);
                } finally {
                    this.decisions.end();
                    this.emit({
                        type: 'attempt_finished',
                        taskId: this.taskId,
                        attemptToken: scope.attemptToken,
                    });
                }
                this.allCalls.push(...cursor.calls);
                if (!failure) {
                    await barrier(() =>
                        persistence!.finish(this.terminal(cursor!, 'completed'), scope)
                    );
                    finalSaved = true;
                    return {
                        modelKey: this.active.model.key,
                        turnKey: this.turnKey,
                        response: cursor.response,
                        reasoning: cursor.reasoning,
                        usage: callsUsage(this.allCalls),
                        calls: [...this.allCalls],
                    };
                }
                if (failure.retryable && attempt < MAX_REQUEST_RETRIES && !this.signal.aborted) {
                    const nextScope = this.scope(
                        attempt + 2,
                        crypto.randomUUID(),
                        checkpoint.iteration
                    );
                    await barrier(() =>
                        persistence!.retry(
                            {
                                errorCode: failure!.code,
                                checkpoint: snapshotCheckpoint(checkpoint),
                                terminal: this.terminal(cursor!, 'failed', failure),
                            },
                            nextScope
                        )
                    );
                    this.emit({
                        type: 'retry_scheduled',
                        taskId: this.taskId,
                        attempt: attempt + 1,
                        errorCode: failure.code,
                        checkpoint: snapshotCheckpoint(checkpoint),
                        discardOutput: cursor.hasVisibleOutput,
                        discardToolActivity: cursor.hasToolActivity,
                    });
                    nextAttemptScope = nextScope;
                    currentScope = nextScope;
                    cursor = {
                        ...snapshotCheckpoint(checkpoint),
                        currentParts: [],
                        privateContents,
                        calls: [],
                        toolArgumentErrors: 0,
                        hasVisibleOutput: false,
                        hasToolActivity: false,
                    };
                    await waitForRetry(attempt + 1, this.signal);
                    continue;
                }
                await barrier(() =>
                    persistence!.finish(
                        this.terminal(
                            cursor!,
                            failure.code === 'REQUEST_CANCELLED' ? 'cancelled' : 'failed',
                            failure
                        ),
                        scope
                    )
                );
                finalSaved = true;
                throw failure;
            }
            throw new AgentError('UNKNOWN');
        } catch (cause) {
            const failure =
                cause instanceof AgentError ? cause : classifyFailure(cause, this.signal);
            // Failed barriers are ambiguous storage state, not permission to write or execute again.
            if (persistence && cursor && !finalSaved && failure.code !== 'PERSISTENCE_FAILED') {
                await barrier(() =>
                    persistence!.finish(
                        this.terminal(
                            cursor!,
                            failure.code === 'REQUEST_CANCELLED' ? 'cancelled' : 'failed',
                            failure
                        ),
                        currentScope
                    )
                );
            }
            throw failure;
        } finally {
            this.decisions.close();
            try {
                await this.active?.release();
            } catch {
                this.emit({ type: 'persistence_issue', taskId: this.taskId, phase: 'cleanup' });
            }
            cursor?.privateContents.clear();
            this.active = null;
        }
    }

    private scope(generation: number, token: string, iteration: number): AgentScope {
        return {
            taskId: this.taskId,
            attemptToken: token,
            attemptGeneration: generation,
            iteration,
            signal: this.signal,
        };
    }

    private terminal(
        cursor: ExecutionCursor,
        status: AgentTerminal['status'],
        error?: AgentError
    ): AgentTerminal {
        return {
            status,
            errorCode: error?.code,
            errorMessage: error?.message,
            outputParts: snapshotParts(cursor.currentParts),
            calls: [...cursor.calls],
            usage: callsUsage(cursor.calls),
            durationMs: Math.max(0, Date.now() - this.startedAt),
            modelSwitchCount: cursor.modelSwitchCount,
            toolArgumentErrors: cursor.toolArgumentErrors,
            hitModelSwitchCeiling: cursor.modelSwitchCount >= MAX_MODEL_SWITCHES,
        };
    }

    private async tools(
        cursor: ExecutionCursor,
        step: ModelStep,
        scope: AgentScope,
        persistence: AgentPersistence
    ): Promise<void> {
        this.emit({ type: 'iteration_start', taskId: this.taskId, iteration: cursor.iteration });
        const callIds = new Set<string>();
        for (const call of step.calls) {
            if (!call.id || callIds.has(call.id)) throw new AgentError('INVALID_TOOL_CALL');
            callIds.add(call.id);
        }
        cursor.messages.push({
            role: 'assistant',
            content: step.parts.map((part) => ({
                type: part.type,
                text: part.content,
                ...(part.providerOptions ? { providerOptions: part.providerOptions } : {}),
            })),
            tool_calls: step.calls,
        });
        const messageKey = await barrier(() =>
            persistence.toolCalls({ parts: step.parts, calls: step.calls, call: step.call }, scope)
        );
        cursor.currentParts = [];
        const controller = new AbortController();
        const abort = () => controller.abort();
        if (this.signal.aborted) abort();
        else this.signal.addEventListener('abort', abort, { once: true });
        let outcomes: AgentToolOutcome[];
        try {
            const settled = await Promise.allSettled(
                step.calls.map(async (call) => {
                    const toolScope: AgentToolScope = {
                        ...scope,
                        messageKey,
                        signal: controller.signal,
                        taskSignal: this.signal,
                        cancelTask: this.cancelTask,
                        approve: (callId, payload) =>
                            controller.signal.aborted
                                ? Promise.resolve(false)
                                : this.decisions.approve(callId, payload, scope.attemptToken),
                        ask: (callId, questions) =>
                            controller.signal.aborted
                                ? Promise.resolve(null)
                                : this.decisions.ask(callId, questions, scope.attemptToken),
                    };
                    if (
                        call.name === 'builtin__activate_skill' &&
                        this.skillActivationAttempts++ >= MAX_SKILL_ACTIVATIONS
                    ) {
                        toolScope.restriction = 'skill_context_limit';
                    }
                    try {
                        return { ...(await this.active!.tools.execute(call, toolScope)), call };
                    } catch (error) {
                        controller.abort();
                        throw error;
                    }
                })
            );
            outcomes = settled.map((result, index) =>
                result.status === 'fulfilled'
                    ? result.value
                    : uncertain(step.calls[index]!, result.reason)
            );
        } finally {
            this.signal.removeEventListener('abort', abort);
        }
        let saveFailure: unknown;
        for (const outcome of outcomes) {
            if (outcome.argumentParseFailed) {
                cursor.toolArgumentErrors++;
                step.call.toolArgumentErrors++;
            }
            const message = toolMessage(outcome);
            if (
                outcome.content !== undefined ||
                (outcome.persistedResult !== undefined &&
                    outcome.persistedResult !== outcome.result)
            ) {
                cursor.privateContents.set(
                    cursor.messages.length,
                    outcome.content ?? outcome.result
                );
            }
            cursor.messages.push(message);
            try {
                await persistence.toolResult(outcome, { ...scope, messageKey });
            } catch (error) {
                saveFailure ??= error;
            }
        }
        if (saveFailure) throw new AgentError('PERSISTENCE_FAILED', false, { cause: saveFailure });
        const origin = await barrier(() =>
            persistence.toolRoundSource(messageKey, step.parts, outcomes)
        );
        if (origin) {
            const first = cursor.messages.length - step.calls.length - 1;
            for (let index = first; index < cursor.messages.length; index++)
                cursor.messages[index] = { ...cursor.messages[index]!, origin };
        }
        this.emit({ type: 'iteration_end', taskId: this.taskId, iteration: cursor.iteration });
        throwIfCancelled(this.signal);
        if (outcomes.some((outcome) => outcome.sideEffect === 'unknown'))
            throw new AgentError('SIDE_EFFECT_UNCERTAIN');
        for (const outcome of outcomes) {
            if (
                outcome.control &&
                (outcome.isError ||
                    !outcome.control.targetKey ||
                    outcome.call.name !== `builtin__${outcome.control.type}` ||
                    !['upgrade_model', 'activate_skill'].includes(outcome.control.type))
            ) {
                throw new AgentError('INVALID_CONTROL');
            }
        }
        const switching = outcomes.find(
            (outcome) => outcome.control?.type === 'upgrade_model'
        )?.control;
        if (switching) {
            if (cursor.modelSwitchCount >= MAX_MODEL_SWITCHES) {
                throw new AgentError('INVALID_CONTROL');
            }
            const previous = this.active!;
            const next = freezeTurn(
                await this.host.prepareTurn(
                    { ...this.input, modelKey: switching.targetKey },
                    {
                        taskId: this.taskId,
                        signal: this.signal,
                        previousModelKey: previous.model.key,
                        modelSwitchCount: cursor.modelSwitchCount + 1,
                    }
                )
            );
            this.active = next;
            await previous.release();
            cursor.modelKey = next.model.key;
            cursor.modelSwitchCount++;
            this.emit({
                type: 'model_switched',
                taskId: this.taskId,
                fromModelKey: previous.model.key,
                modelKey: next.model.key,
                restart: switching.restart ?? false,
            });
        }
    }
}
