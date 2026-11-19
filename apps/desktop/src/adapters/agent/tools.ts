import type { AgentToolResult, AgentTools, AgentToolScope } from '@touchai/agent-core/contracts';
import type { AiToolCall, JsonObject } from '@touchai/models/contracts';

import type { AttachmentContentPart } from '@/modules/attachments';
import type { ToolAttachment, ToolEvent, ToolModelReference, ToolSnapshot } from '@/modules/tools';

import type { AgentMessageAdapter } from './messages';

export interface CoreToolsAdapterOptions {
    snapshot: ToolSnapshot;
    messages: AgentMessageAdapter;
    model: ToolModelReference;
    historyTarget(messageKey: string): { sessionId: number; messageId: number };
    present(event: ToolEvent, scope: { taskId: string; attemptToken: string }): void;
    materialize(
        attachments: readonly ToolAttachment[],
        signal: AbortSignal
    ): Promise<AttachmentContentPart[]>;
    executed?(name: string): void;
}

/** Core receives frozen declarations and execution only, never registry mutation or Desktop records. */
export function createCoreToolsAdapter(options: CoreToolsAdapterOptions): AgentTools {
    const execute = options.snapshot.execute.bind(options.snapshot);
    const model = structuredClone(options.model);
    const historyTarget = options.historyTarget.bind(options);
    const present = options.present.bind(options);
    const materialize = options.materialize.bind(options);
    const executed = options.executed?.bind(options);
    const toCoreContent = options.messages.toCoreContent.bind(options.messages);
    return Object.freeze({
        declarations: Object.freeze(
            options.snapshot.declarations.map((declaration) =>
                Object.freeze({
                    name: declaration.name,
                    description: declaration.description,
                    input_schema: structuredClone(declaration.input_schema),
                })
            )
        ),
        async execute(call: AiToolCall, scope: AgentToolScope): Promise<AgentToolResult> {
            if (!scope.messageKey) throw new Error('TOOL_RESULT_TARGET_MISSING');
            const {
                taskId,
                attemptToken,
                attemptGeneration,
                iteration,
                restriction,
                signal,
                taskSignal,
                messageKey,
            } = scope;
            const approve = scope.approve.bind(scope);
            const ask = scope.ask.bind(scope);
            const cancelTask = scope.cancelTask.bind(scope);
            const outcome = await execute(call, {
                iteration,
                restriction,
                signal,
                requestApproval: (callId, approval) =>
                    approve(callId, { ...approval } as JsonObject),
                task: {
                    taskId,
                    attemptToken,
                    attemptGeneration,
                    signal: taskSignal,
                    stop: cancelTask,
                    historyTarget: historyTarget(messageKey),
                    currentModel: model,
                    ask: (callId, questions) => ask(callId, questions),
                    present: (event) => {
                        if (!signal.aborted && !taskSignal.aborted)
                            present(event, { taskId, attemptToken });
                    },
                },
            });
            const result: AgentToolResult = {
                result: outcome.result,
                isError: outcome.isError,
                sideEffect: outcome.sideEffect,
                ...(outcome.persistedResult !== undefined
                    ? { persistedResult: outcome.persistedResult }
                    : {}),
                ...(outcome.receiptKey ? { receiptKey: outcome.receiptKey } : {}),
                ...(outcome.control ? { control: { ...outcome.control } } : {}),
                ...(outcome.argumentParseFailed ? { argumentParseFailed: true } : {}),
            };
            if (outcome.attachments?.length && !signal.aborted && !taskSignal.aborted) {
                const parts = await materialize(outcome.attachments, signal);
                if (!signal.aborted && !taskSignal.aborted && parts.length) {
                    result.content = toCoreContent([
                        ...(outcome.result
                            ? [{ type: 'text' as const, text: outcome.result }]
                            : []),
                        ...parts,
                    ]);
                    const saved = outcome.persistedResult ?? outcome.result;
                    result.persistedContent = toCoreContent([
                        ...(saved ? [{ type: 'text' as const, text: saved }] : []),
                        ...parts,
                    ]);
                }
            }
            if (!outcome.isError && !signal.aborted && !taskSignal.aborted) executed?.(call.name);
            return result;
        },
    });
}
