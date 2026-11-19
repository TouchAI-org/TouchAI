import type { AgentEvent, AgentTerminal } from '@touchai/agent-core/contracts';

import { AppEvent, eventService } from '@/app/workflows/windows/events';
import type { AttachmentReference } from '@/modules/agent/contracts';
import type { ToolEvent } from '@/modules/tools';
import type { UsageCall } from '@/modules/usage';
import { LiveUsageTracker, readLiveOutputPrice } from '@/modules/usage';
import { log } from '@/platform/diagnostics';

import { type createAgentAnalytics, toolCategoryForName } from './analytics';
import type { MainTaskObservations } from './host';

/** Passive observations follow committed Core events; they never acknowledge task success. */
export function createMainTaskObservations(
    input: {
        taskId: string;
        signal: AbortSignal;
        executionMode: 'foreground' | 'background';
        attachmentCount: number;
        releaseNotification(): void;
    },
    identity: (key: string) => {
        id: number;
        providerId: number;
        providerName: string;
        modelId: string;
    },
    createAnalytics: ReturnType<typeof createAgentAnalytics>['createRequest']
): MainTaskObservations {
    const analytics = createAnalytics({
        requestKind: 'chat',
        surface: input.executionMode === 'background' ? 'other' : 'main',
    });
    analytics.submit({ attachmentCount: input.attachmentCount });
    let disposed = false;
    let completed = false;
    let retryCount = 0;
    let tracker: LiveUsageTracker | undefined;
    let terminal: { value: AgentTerminal; saved: boolean } | undefined;
    const attemptCalls: AgentTerminal['calls'][] = [];
    const tools = new Map<string, { name: string; started: number; leave(): void }>();
    const approvals = new Map<string, { started: number; leave(): void }>();
    const abort = () => {
        if (!disposed && !completed) analytics.noteAbort();
    };
    if (input.signal.aborted) abort();
    else input.signal.addEventListener('abort', abort, { once: true });
    const recordTerminal = (value: AgentTerminal, saved: boolean) => {
        if (disposed || completed) return;
        terminal = { value, saved };
        attemptCalls.push(value.calls);
    };
    const finish = (
        event: Extract<AgentEvent, { type: 'task_completed' | 'task_failed' | 'task_cancelled' }>
    ) => {
        if (completed) return;
        completed = true;
        const calls: UsageCall[] = attemptCalls.flat().map((call) => {
            const model = identity(call.modelKey);
            return {
                iteration: call.iteration,
                modelId: model.id,
                modelName: model.modelId,
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
        if (event.type === 'task_completed')
            tracker?.finish({ outputTokens: event.result.usage.outputTokens, costMicros: null });
        else tracker?.stop();
        if (event.type === 'task_cancelled') analytics.noteAbort();
        // Aborted effects suppress late presentation; account for their local wait once.
        for (const tool of tools.values()) {
            analytics.noteToolCompleted({
                category: toolCategoryForName(tool.name),
                result: input.signal.aborted ? 'cancelled' : 'failure',
                durationMs: Date.now() - tool.started,
            });
            tool.leave();
        }
        for (const approval of approvals.values()) {
            analytics.noteApprovalResolved({
                resolution: input.signal.aborted ? 'cancelled' : 'rejected',
                waitMs: Date.now() - approval.started,
            });
            approval.leave();
        }
        tools.clear();
        approvals.clear();
        analytics.complete({
            result:
                event.type === 'task_completed'
                    ? 'success'
                    : event.type === 'task_cancelled'
                      ? 'cancelled'
                      : 'failure',
            retryCount,
            modelSwitchCount: terminal?.value.modelSwitchCount ?? 0,
            providerTtftMs: calls.find((call) => call.timing.ttftMs !== undefined)?.timing.ttftMs,
            errorCode: event.type === 'task_completed' ? null : event.errorCode,
            persistenceResult: terminal ? (terminal.saved ? 'saved' : 'failed') : 'not_applicable',
            calls,
            usageReportedCalls: calls.filter((call) => call.usageReported === true).length,
        });
    };
    return Object.freeze<MainTaskObservations>({
        beginStream() {
            return disposed || completed ? () => undefined : analytics.enterPhase('streaming');
        },
        stream(chunk) {
            if (disposed || completed) return;
            if (chunk.content) analytics.noteFirstOutput();
            tracker?.consume(chunk);
        },
        event(event) {
            if (disposed || completed) return;
            if (event.type === 'task_started') {
                const model = identity(event.modelKey);
                const match = event.conversationKey?.match(/^session:([1-9][0-9]*)$/);
                tracker = new LiveUsageTracker({
                    taskId: input.taskId,
                    sessionId: match ? Number(match[1]) : null,
                    modelName: model.modelId,
                    estimatedOutputCostPerMillion: null,
                    publish: (progress) => {
                        void eventService
                            .emit(AppEvent.SESSION_TASK_USAGE_PROGRESS, progress)
                            .catch(() => undefined);
                    },
                });
                tracker.start();
                void readLiveOutputPrice(model.modelId).then(
                    (price) => {
                        if (disposed || completed) return;
                        tracker?.updateOutputPrice(price);
                    },
                    (error: unknown) => log.warn('[Agent] Live usage pricing unavailable', error)
                );
            } else if (event.type === 'retry_scheduled') retryCount = event.attempt;
            else if (event.type === 'decision_required' && event.kind === 'approval') {
                approvals.set(event.decisionId, {
                    started: Date.now(),
                    leave: analytics.enterPhase('approval'),
                });
            } else if (event.type === 'decision_resolved' && event.kind === 'approval') {
                const approval = approvals.get(event.decisionId);
                if (approval) {
                    if (input.signal.aborted) analytics.noteAbort();
                    approvals.delete(event.decisionId);
                    approval.leave();
                    analytics.noteApprovalResolved({
                        resolution: input.signal.aborted
                            ? 'cancelled'
                            : event.value === true
                              ? 'approved'
                              : event.value === null
                                ? 'cancelled'
                                : 'rejected',
                        waitMs: Date.now() - approval.started,
                    });
                }
            } else if (
                event.type === 'task_completed' ||
                event.type === 'task_failed' ||
                event.type === 'task_cancelled'
            )
                finish(event);
        },
        tool(event: ToolEvent) {
            if (disposed || completed) return;
            if (event.type === 'call_start' && !tools.has(event.callId))
                tools.set(event.callId, {
                    name: event.namespacedName,
                    started: Date.now(),
                    leave: analytics.enterPhase('tool'),
                });
            else if (event.type === 'call_end') {
                const tool = tools.get(event.callId);
                if (tool) {
                    tools.delete(event.callId);
                    tool.leave();
                    analytics.noteToolCompleted({
                        category: toolCategoryForName(tool.name),
                        result: input.signal.aborted
                            ? 'cancelled'
                            : event.isError || event.finalStatus === 'rejected'
                              ? 'failure'
                              : 'success',
                        durationMs: event.durationMs,
                    });
                }
            }
        },
        attachmentPrepared(attachments: readonly AttachmentReference[], result, durationMs) {
            analytics.noteAttachmentPreparation({
                attachments,
                result,
                durationMs,
                ...(result === 'failure' ? { errorCategory: 'io' as const } : {}),
            });
        },
        retry: recordTerminal,
        terminal: recordTerminal,
        dispose() {
            disposed = true;
            input.signal.removeEventListener('abort', abort);
            tracker?.stop();
            for (const tool of tools.values()) tool.leave();
            for (const approval of approvals.values()) approval.leave();
            tools.clear();
            approvals.clear();
            terminal = undefined;
            attemptCalls.length = 0;
            input.releaseNotification();
        },
    });
}
