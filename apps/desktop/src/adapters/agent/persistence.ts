import type {
    AgentCall,
    AgentCheckpoint,
    AgentPersistence,
    AgentScope,
    AgentTerminal,
} from '@touchai/agent-core/contracts';
import { AgentError } from '@touchai/agent-core/contracts';

import type { PersistenceCheckpoint, PersistenceProjector } from '@/modules/agent';
import type {
    PersistedOutputPart,
    PersistenceCall as AiCallRecord,
} from '@/modules/agent/contracts';
import type { AttachmentIndex } from '@/modules/attachments';
import type { ToolAudit, ToolInvocationScope } from '@/modules/tools';

import type { AgentMessageAdapter } from './messages';

type DesktopTaskPersistence = Pick<
    PersistenceProjector,
    | 'recordTurnStart'
    | 'persistOutputProgress'
    | 'persistToolCallMessage'
    | 'persistToolResult'
    | 'getContextMessageSource'
    | 'persistCheckpoint'
    | 'beginNextAttempt'
    | 'markCompleted'
    | 'markFailed'
    | 'markCancelled'
    | 'validateContextSummary'
    | 'persistContextSummary'
    | 'getSessionId'
    | 'getTurn'
>;

export interface ToolPersistenceReceipt {
    partId: number;
    input: string;
    attachments?: AttachmentIndex[];
}

export interface ToolAuditAdmission {
    taskId: string;
    attemptToken: string;
    attemptGeneration: number;
    sessionId: number;
    messageId: number;
}

interface CoreToolAuditPort {
    begin(
        call: import('@touchai/models/contracts').AiToolCall,
        args: Record<string, unknown> | string,
        scope: ToolInvocationScope
    ): Promise<ToolAudit>;
    receipt(
        key: string | undefined,
        scope: { taskId: string; attemptToken: string }
    ): ToolPersistenceReceipt | undefined;
    commit(): void;
    dispose(): void;
}

interface CorePersistenceBaseOptions {
    persistence: DesktopTaskPersistence;
    messages: AgentMessageAdapter;
    modelIdentity(key: string): {
        id: number;
        providerId: number;
        providerName: string;
        modelId: string;
    };
    languageContext: PersistenceCheckpoint['modelLanguageContext'];
    errorText?(code: string): string;
    legacyExecutedToolIds?(): readonly string[];
}

export type CorePersistenceOptions = CorePersistenceBaseOptions &
    (
        | {
              toolReceipt(
                  key: string | undefined,
                  scope: { taskId: string; attemptToken: string }
              ): ToolPersistenceReceipt | undefined;
              bindToolAudit?: never;
          }
        | {
              bindToolAudit(isCurrent: (scope: ToolInvocationScope) => boolean): CoreToolAuditPort;
              toolReceipt?: never;
          }
    );

export interface CorePersistenceAdapter extends AgentPersistence {
    isCurrentScope(
        scope: Pick<AgentScope, 'taskId' | 'attemptToken' | 'attemptGeneration'>
    ): boolean;
    isToolAuditCurrent(admission: ToolAuditAdmission): boolean;
    beginToolAudit(
        call: import('@touchai/models/contracts').AiToolCall,
        args: Record<string, unknown> | string,
        scope: ToolInvocationScope
    ): Promise<ToolAudit>;
    dispose(): void;
}

export function createCorePersistenceAdapter(
    options: CorePersistenceOptions
): CorePersistenceAdapter {
    const source = options.persistence;
    const persistence = Object.freeze({
        recordTurnStart: source.recordTurnStart.bind(source),
        persistOutputProgress: source.persistOutputProgress.bind(source),
        persistToolCallMessage: source.persistToolCallMessage.bind(source),
        persistToolResult: source.persistToolResult.bind(source),
        getContextMessageSource: source.getContextMessageSource.bind(source),
        persistCheckpoint: source.persistCheckpoint.bind(source),
        beginNextAttempt: source.beginNextAttempt.bind(source),
        markCompleted: source.markCompleted.bind(source),
        markFailed: source.markFailed.bind(source),
        markCancelled: source.markCancelled.bind(source),
        validateContextSummary: source.validateContextSummary.bind(source),
        persistContextSummary: source.persistContextSummary.bind(source),
        getSessionId: source.getSessionId.bind(source),
        getTurn: source.getTurn.bind(source),
    });
    const messages = options.messages;
    const modelIdentity = options.modelIdentity.bind(options);
    const errorText = options.errorText?.bind(options);
    const legacyExecutedToolIds = options.legacyExecutedToolIds?.bind(options);
    const languageContext = structuredClone(options.languageContext);
    let activeScope: AgentScope | undefined;
    let activeModelKey: string | undefined;
    let activeToolMessageId: number | undefined;
    let finished = false;
    const matches = (scope: Pick<AgentScope, 'taskId' | 'attemptToken' | 'attemptGeneration'>) =>
        activeScope?.taskId === scope.taskId &&
        activeScope.attemptToken === scope.attemptToken &&
        activeScope.attemptGeneration === scope.attemptGeneration;
    const assertCurrent = (scope: AgentScope) => {
        if (!matches(scope) || finished) throw new Error('PERSISTENCE_SCOPE_STALE');
    };
    const isToolAuditCurrent = (admission: ToolAuditAdmission) =>
        !finished &&
        matches(admission) &&
        activeToolMessageId !== undefined &&
        activeToolMessageId === admission.messageId &&
        persistence.getSessionId() === admission.sessionId;
    const audit = options.bindToolAudit?.(
        (scope) =>
            !!scope.task &&
            isToolAuditCurrent({
                taskId: scope.task.taskId,
                attemptToken: scope.task.attemptToken,
                attemptGeneration: scope.task.attemptGeneration,
                sessionId: scope.task.historyTarget.sessionId,
                messageId: scope.task.historyTarget.messageId,
            })
    );
    const toolReceipt = audit?.receipt.bind(audit) ?? options.toolReceipt?.bind(options);
    if (!toolReceipt) throw new Error('TOOL_RECEIPTS_REQUIRED');
    const toCheckpoint = (checkpoint: AgentCheckpoint): PersistenceCheckpoint => ({
        activeModel: { id: modelIdentity(checkpoint.modelKey).id },
        messages: messages.toDesktop(checkpoint.messages),
        iteration: checkpoint.iteration,
        modelSwitchCount: checkpoint.modelSwitchCount,
        modelLanguageContext: { ...languageContext },
        executedBuiltInToolIds: [...(legacyExecutedToolIds?.() ?? [])],
        response: checkpoint.response,
        reasoning: checkpoint.reasoning,
        outputParts: checkpoint.outputParts,
    });
    const toCalls = (calls: readonly AgentCall[]): AiCallRecord[] =>
        calls.map((call) => {
            const model = modelIdentity(call.modelKey);
            return {
                iteration: call.iteration,
                modelId: model.id,
                modelName: call.model,
                providerId: model.providerId,
                providerName: model.providerName,
                usage: call.usage,
                usageReported: call.usageReported,
                timing: call.timing,
                finishReason: call.finishReason,
                toolCallsInStep: call.toolCallsInStep,
                toolArgumentErrors: call.toolArgumentErrors,
            };
        });
    const usage = (terminal: AgentTerminal) => ({
        calls: toCalls(terminal.calls),
        ttftMs:
            terminal.calls.find((call) => call.timing.ttftMs !== undefined)?.timing.ttftMs ?? null,
        firstTextMs:
            terminal.calls.find((call) => call.timing.firstTextMs !== undefined)?.timing
                .firstTextMs ?? null,
        toolArgumentErrors: terminal.toolArgumentErrors,
        modelSwitchCount: terminal.modelSwitchCount,
        hitModelSwitchCeiling: terminal.hitModelSwitchCeiling,
        errorCode: terminal.errorCode,
    });

    return Object.freeze({
        async start(checkpoint, scope) {
            if (activeScope || finished) throw new Error('PERSISTENCE_ALREADY_STARTED');
            const stored = toCheckpoint(checkpoint);
            await persistence.recordTurnStart(stored);
            activeScope = Object.freeze({ ...scope });
            activeModelKey = checkpoint.modelKey;
            const currentUser = stored.messages[stored.messages.length - 1]?.contextSource;
            const sessionId = persistence.getSessionId();
            const turnId = persistence.getTurn()?.id;
            return {
                conversationKey: sessionId === null ? undefined : `session:${sessionId}`,
                turnKey: turnId === undefined ? undefined : `turn:${turnId}`,
                currentUserOrigin: currentUser ? messages.toCoreSource(currentUser) : undefined,
            };
        },
        async progress(parts, target) {
            if (!matches(target) || finished) return;
            await persistence.persistOutputProgress(parts as PersistedOutputPart[], {
                attemptGeneration: target.attemptGeneration,
                step: target.step,
            });
        },
        async toolCalls(step, scope) {
            assertCurrent(scope);
            const messageId = await persistence.persistToolCallMessage(
                step.parts as PersistedOutputPart[]
            );
            assertCurrent(scope);
            activeToolMessageId = messageId;
            return messages.messageReference(messageId);
        },
        async toolResult(outcome, scope) {
            assertCurrent(scope);
            if (messages.messageId(scope.messageKey) !== activeToolMessageId)
                throw new Error('TOOL_RESULT_TARGET_MISSING');
            const receipt = toolReceipt(outcome.receiptKey, scope);
            await persistence.persistToolResult({
                result: outcome.persistedResult ?? outcome.result,
                toolCallId: outcome.call.id,
                toolCallPartId: receipt?.partId ?? null,
                toolCallMessageId: messages.messageId(scope.messageKey),
                attachments: receipt?.attachments,
            });
        },
        async toolRoundSource(messageKey, parts, outcomes) {
            if (
                !activeScope ||
                finished ||
                messages.messageId(messageKey) !== activeToolMessageId
            ) {
                throw new Error('PERSISTENCE_SCOPE_STALE');
            }
            const scope = activeScope;
            const source = await persistence.getContextMessageSource(
                messages.messageId(messageKey),
                {
                    outputParts: parts as PersistedOutputPart[],
                    results: outcomes.map((outcome) => {
                        const receipt = toolReceipt(outcome.receiptKey, scope);
                        return {
                            toolCall: outcome.call,
                            input: outcome.input ?? receipt?.input,
                            result: outcome.persistedResult ?? outcome.result,
                            isError: outcome.isError,
                            attachments: receipt?.attachments,
                        };
                    }),
                }
            );
            return source ? messages.toCoreSource(source) : undefined;
        },
        async checkpoint(checkpoint, scope) {
            assertCurrent(scope);
            await persistence.persistCheckpoint(toCheckpoint(checkpoint));
            activeModelKey = checkpoint.modelKey;
            messages.retain(checkpoint.messages);
            activeToolMessageId = undefined;
            audit?.commit();
        },
        async retry(failure, scope) {
            if (
                !activeScope ||
                scope.taskId !== activeScope.taskId ||
                scope.attemptGeneration !== activeScope.attemptGeneration + 1 ||
                scope.attemptToken === activeScope.attemptToken ||
                finished
            ) {
                throw new Error('PERSISTENCE_SCOPE_STALE');
            }
            await persistence.beginNextAttempt(
                errorText?.(failure.errorCode) ?? failure.errorCode,
                toCheckpoint(failure.checkpoint),
                usage(failure.terminal)
            );
            activeScope = Object.freeze({ ...scope });
            activeModelKey = failure.checkpoint.modelKey;
            activeToolMessageId = undefined;
            audit?.commit();
        },
        async finish(terminal, scope) {
            assertCurrent(scope);
            const parts = terminal.outputParts as PersistedOutputPart[];
            if (terminal.status === 'completed') {
                await persistence.markCompleted({
                    durationMs: terminal.durationMs,
                    outputParts: parts,
                    ...usage(terminal),
                    tokensUsed:
                        terminal.usage.inputTokens +
                        terminal.usage.outputTokens +
                        terminal.usage.cacheReadTokens +
                        terminal.usage.cacheWriteTokens,
                });
            } else if (terminal.status === 'cancelled')
                await persistence.markCancelled(parts, usage(terminal));
            else
                await persistence.markFailed(
                    errorText?.(terminal.errorCode ?? 'UNKNOWN') ?? terminal.errorCode ?? 'UNKNOWN',
                    parts,
                    usage(terminal)
                );
            finished = true;
            activeToolMessageId = undefined;
            audit?.commit();
        },
        async validateSummary(message, scope) {
            assertCurrent(scope);
            await persistence.validateContextSummary(messages.toDesktop([message])[0]!);
        },
        async saveSummary(summary, source, calls, scope) {
            assertCurrent(scope);
            if (!activeModelKey) throw new Error('MODEL_BINDING_NOT_FOUND');
            const model = modelIdentity(activeModelKey);
            try {
                const partId = await persistence.persistContextSummary(
                    {
                        ...messages.toDesktopSummary(summary),
                        model: summary.model,
                        providerId: model.providerId,
                        createdAt: summary.createdAt,
                        tokensBefore: summary.tokensBefore,
                        tokensAfter: summary.tokensAfter,
                    },
                    toCalls(calls),
                    messages.toDesktopSummarySource(source)
                );
                return messages.summaryPartKey(partId);
            } catch (cause) {
                if (cause instanceof AgentError) throw cause;
                throw new AgentError('PERSISTENCE_FAILED', false, { cause });
            }
        },
        isToolAuditCurrent,
        isCurrentScope: (scope) => !finished && matches(scope),
        beginToolAudit(call, args, scope) {
            if (!audit) throw new Error('TOOL_AUDIT_UNBOUND');
            return audit.begin(call, args, scope);
        },
        dispose() {
            finished = true;
            activeToolMessageId = undefined;
            audit?.dispose();
        },
    } satisfies CorePersistenceAdapter);
}
