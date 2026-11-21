import type {
    AgentEvent,
    AgentHost,
    AgentModel,
    AgentPreparedTurn,
    AgentScope,
    AgentStartInput,
    AgentTerminal,
} from '@touchai/agent-core/contracts';
import type { AiRequestOptions, AiStreamChunk } from '@touchai/models/contracts';
import { AiError, AiErrorCode } from '@touchai/models/contracts';

import type { AgentMessageAdapter } from '@/adapters/agent/messages';
import { createAgentMessageAdapter } from '@/adapters/agent/messages';
import { createCoreModelStream } from '@/adapters/agent/model';
import type { CorePersistenceAdapter } from '@/adapters/agent/persistence';
import { createCorePersistenceAdapter } from '@/adapters/agent/persistence';
import { createCoreToolsAdapter } from '@/adapters/agent/tools';
import type { PrivacyApi } from '@/app/api/privacy';
import type { PersistenceProjector } from '@/modules/agent';
import { createSessionReadModel, summarizePromptSnapshot } from '@/modules/agent';
import type {
    AgentPendingDelivery,
    AgentPresentationChunk,
    AgentSessionHost,
    AttachmentReference,
    PromptSnapshot,
    StartSessionTaskOptions,
} from '@/modules/agent/contracts';
import {
    buildAttachmentParts,
    ensurePersistedAttachmentIndex,
    getUnsupportedAttachmentTypes,
} from '@/modules/attachments';
import type { ModelSummary } from '@/modules/models';
import type { PrivacyRestoredSpan } from '@/modules/privacy/public';
import type { ToolEvent, ToolModelReference, ToolsModule } from '@/modules/tools';
import { createPublicWidgetStream, createToolAudit, createWidgetDrafts } from '@/modules/tools';
import { awaitAbortable } from '@/utils/abort';
import { collapseWhitespace, truncateText } from '@/utils/text';

import { findUnsupportedSessionAttachmentTypes } from './historyTransport';
import type { TaskModelLease } from './modelBindings';
import {
    createPendingMessageDelivery,
    createPendingMessagePersistence,
    reportQueuedMessageStartFailure,
} from './pending';
import { createTaskPersistence } from './persistence';
import { createDesktopPrivacyStream } from './privacy';
import { composePromptSnapshot } from './prompt';
import { buildPromptTransportMessages } from './transport';

export interface MainTaskObservations {
    beginStream?(): () => void;
    stream(chunk: AiStreamChunk): void;
    event(event: AgentEvent): void;
    tool?(event: ToolEvent): void;
    attachmentPrepared(
        attachments: readonly AttachmentReference[],
        result: 'success' | 'failure',
        durationMs: number
    ): void;
    retry?(terminal: AgentTerminal, saved: boolean): void;
    terminal(terminal: AgentTerminal, saved: boolean): void;
    dispose(): void;
}

export interface MainAgentWorkflowOptions {
    privacy?: PrivacyApi;
    models: {
        start(
            taskId: string,
            selected?: { providerId?: number; modelId?: string }
        ): Promise<ToolModelReference>;
        acquire(taskId: string, key: string): Promise<TaskModelLease>;
        describe(taskId: string, key: string): ModelSummary | null;
        recordUse(taskId: string, key: string): Promise<void>;
        disposeTask(taskId: string): void;
    };
    disposeModels(): void;
    tools: Pick<ToolsModule, 'snapshot'>;
    sessions: Omit<AgentSessionHost, 'execution' | 'modelSummary' | 'subscribePresentation'>;
    diagnostics: {
        warn(message: string, error: unknown): void;
        error(message: string, error: unknown): void;
    };
    createObservations(
        input: {
            taskId: string;
            signal: AbortSignal;
            executionMode: 'foreground' | 'background';
            attachmentCount: number;
        },
        modelIdentity: (key: string) => {
            id: number;
            providerId: number;
            providerName: string;
            modelId: string;
        }
    ): MainTaskObservations;
    releaseActivity(signal: AbortSignal): Promise<void>;
}

interface TaskResources {
    userMessageId?: string;
    initialUserContent?: import('@/adapters/models/input').DesktopModelMessage['content'];
    initialUserSourceId?: number;
    userSourcePresented?: boolean;
    pendingRestoration?: { content: string; spans: PrivacyRestoredSpan[]; generation: number };
    pendingMessageId?: string;
    pendingDelivery?: AgentPendingDelivery;
    signal: AbortSignal;
    modelKey: string;
    messages: AgentMessageAdapter;
    projector: PersistenceProjector;
    persistence: CorePersistenceAdapter;
    snapshot: PromptSnapshot;
    fragments: PromptSnapshot['fragments'];
    executed: Set<string>;
    transportAttempt?: string;
    nextRequestIndex: number;
}

type PresentationListener = (chunk: AgentPresentationChunk, attemptToken: string) => void;

/** Coordinates Desktop capabilities. All execution, retries and decisions stay in Core. */
export function createMainAgentWorkflow(input: MainAgentWorkflowOptions) {
    const snapshotTools = input.tools.snapshot.bind(input.tools);
    const createObservations = input.createObservations.bind(input);
    const releaseActivity = input.releaseActivity.bind(input);
    const sessions = Object.freeze({
        pendingMessages: input.sessions.pendingMessages ?? createPendingMessagePersistence(),
        beforeStart: input.sessions.beforeStart.bind(input.sessions),
        loadHistory: input.sessions.loadHistory.bind(input.sessions),
        messages: Object.freeze({
            tt: input.sessions.messages.tt.bind(input.sessions.messages),
            errorText: input.sessions.messages.errorText.bind(input.sessions.messages),
            retryText: input.sessions.messages.retryText.bind(input.sessions.messages),
        }),
        tools: Object.freeze({
            resolveSemantic: input.sessions.tools.resolveSemantic.bind(input.sessions.tools),
            presentation: input.sessions.tools.presentation.bind(input.sessions.tools),
            widgetToolName: input.sessions.tools.widgetToolName,
        }),
        publishStatus: input.sessions.publishStatus?.bind(input.sessions),
        reportObserverError: input.sessions.reportObserverError?.bind(input.sessions),
    });
    const diagnostics = Object.freeze({
        warn: input.diagnostics.warn.bind(input.diagnostics),
        error: input.diagnostics.error.bind(input.diagnostics),
    });
    const bindings = Object.freeze({
        start: input.models.start.bind(input.models),
        acquire: input.models.acquire.bind(input.models),
        describe: input.models.describe.bind(input.models),
        recordUse: input.models.recordUse.bind(input.models),
        disposeTask: input.models.disposeTask.bind(input.models),
    });
    const disposeModels = input.disposeModels.bind(input);
    const staged = new Map<
        string,
        { options: StartSessionTaskOptions; pendingDelivery?: AgentPendingDelivery }
    >();
    const resources = new Map<string, TaskResources>();
    const outputs = new Map<string, MainTaskObservations>();
    const presentation = new Map<string, Set<PresentationListener>>();
    const drafts = createWidgetDrafts({ t: sessions.messages.tt, tt: sessions.messages.tt });
    let disposed = false;
    const report = (message: string, error: unknown) => {
        try {
            diagnostics.warn(message, error);
        } catch {
            /* Diagnostics cannot change task outcomes. */
        }
    };
    const observe = <T>(
        taskId: string,
        action: (output: MainTaskObservations) => T
    ): T | undefined => {
        const output = outputs.get(taskId);
        if (output)
            try {
                return action(output);
            } catch (error) {
                report('[Agent] Observation failed', error);
            }
    };
    const identity = (taskId: string, key: string) => {
        const model = bindings.describe(taskId, key);
        if (!model) throw new Error('MODEL_BINDING_NOT_FOUND');
        return {
            id: model.modelDbId,
            providerId: model.providerId,
            providerName: model.providerName,
            modelId: model.modelId,
        };
    };
    const present = (taskId: string, attemptToken: string, event: ToolEvent) => {
        const record = resources.get(taskId);
        if (!record || record.signal.aborted || disposed) return;
        observe(taskId, (output) => output.tool?.(event));
        for (const listener of presentation.get(taskId) ?? []) {
            try {
                listener(
                    { content: '', done: false, toolEvent: structuredClone(event) },
                    attemptToken
                );
            } catch (error) {
                report('[Agent] Presentation observer failed', error);
            }
        }
    };

    async function releaseTask(taskId: string): Promise<void> {
        const record = resources.get(taskId);
        const output = outputs.get(taskId);
        resources.delete(taskId);
        outputs.delete(taskId);
        presentation.delete(taskId);
        const failures: unknown[] = [];
        for (const release of [
            () => record?.persistence.dispose(),
            () => record?.messages.dispose(),
            () => bindings.disposeTask(taskId),
            () => output?.dispose(),
        ]) {
            try {
                release();
            } catch (error) {
                failures.push(error);
            }
        }
        if (record)
            try {
                await releaseActivity(record.signal);
            } catch (error) {
                failures.push(error);
            }
        if (failures.length) throw new AggregateError(failures, 'AGENT_RESOURCE_CLEANUP_FAILED');
    }

    const host: AgentHost = {
        async prepareTurn(request, scope): Promise<AgentPreparedTurn> {
            if (disposed) throw new Error('AGENT_DISPOSED');
            scope.signal.throwIfAborted();
            let record = resources.get(scope.taskId);
            let reference: ToolModelReference | undefined;
            let options: StartSessionTaskOptions | undefined;
            let pendingDelivery: AgentPendingDelivery | undefined;
            if (scope.previousModelKey !== undefined) {
                if (!record || record.signal !== scope.signal || !request.modelKey)
                    throw new Error('MODEL_BINDING_NOT_FOUND');
            } else {
                const stagedRequest = request.requestKey
                    ? staged.get(request.requestKey)
                    : undefined;
                options = stagedRequest?.options;
                pendingDelivery = stagedRequest?.pendingDelivery;
                if (!options || record) throw new Error('AGENT_REQUEST_NOT_FOUND');
                staged.delete(request.requestKey!);
                outputs.set(
                    scope.taskId,
                    createObservations(
                        {
                            taskId: scope.taskId,
                            signal: scope.signal,
                            executionMode: options.executionMode ?? 'foreground',
                            attachmentCount: options.attachments?.length ?? 0,
                        },
                        (key) => identity(scope.taskId, key)
                    )
                );
                const selected = { providerId: options.providerId, modelId: options.modelId };
                reference = await awaitAbortable(
                    () => bindings.start(scope.taskId, selected),
                    scope.signal
                );
                scope.signal.throwIfAborted();
            }
            const modelKey = request.modelKey ?? reference!.key;
            const lease = await awaitAbortable(
                () => bindings.acquire(scope.taskId, modelKey),
                scope.signal
            );
            try {
                scope.signal.throwIfAborted();
                const configured = lease.model;
                let messages: AgentPreparedTurn['messages'] = [];
                if (!record) {
                    if (!options) throw new Error('AGENT_REQUEST_NOT_FOUND');
                    const attachments = options.attachments ?? [];
                    const readModel = createSessionReadModel();
                    const unsupported = new Set([
                        ...getUnsupportedAttachmentTypes(attachments, configured.capabilities),
                        ...(await findUnsupportedSessionAttachmentTypes({
                            sessionId: options.sessionId,
                            capabilities: configured.capabilities,
                            readModel,
                            signal: scope.signal,
                        })),
                    ]);
                    scope.signal.throwIfAborted();
                    if (unsupported.size)
                        throw new AiError(AiErrorCode.UNSUPPORTED_INPUT, {
                            unsupportedAttachmentTypes: [...unsupported],
                            modelId: configured.summary.modelId,
                            providerId: configured.summary.providerId,
                        });
                    if (attachments.length) {
                        const started = performance.now();
                        const results = await awaitAbortable(
                            () =>
                                Promise.allSettled(
                                    attachments.map((attachment) =>
                                        ensurePersistedAttachmentIndex(attachment)
                                    )
                                ),
                            scope.signal
                        );
                        const failed = results.some((result) => result.status === 'rejected');
                        for (const result of results)
                            if (result.status === 'rejected') {
                                report('[Agent] Attachment preparation failed', result.reason);
                            }
                        observe(scope.taskId, (output) =>
                            output.attachmentPrepared(
                                attachments,
                                failed ? 'failure' : 'success',
                                performance.now() - started
                            )
                        );
                    }
                    scope.signal.throwIfAborted();
                    const liveSnapshot = await composePromptSnapshot({
                        prompt: options.prompt,
                        attachments,
                        inputSnapshot: options.inputSnapshot,
                        executionMode: options.executionMode ?? 'foreground',
                        signal: scope.signal,
                        diagnostics,
                    });
                    const snapshot = summarizePromptSnapshot(liveSnapshot);
                    const desktopMessages = await buildPromptTransportMessages({
                        sessionId: options.sessionId,
                        snapshot,
                        attachments,
                        attachmentCapabilities: configured.capabilities,
                        readModel,
                        signal: scope.signal,
                        diagnostics,
                    });
                    scope.signal.throwIfAborted();
                    const messageAdapter = createAgentMessageAdapter();
                    try {
                        messages = messageAdapter.toCore(desktopMessages);
                        const executed = new Set<string>();
                        const projector = createTaskPersistence({
                            prompt: options.prompt,
                            pendingMessageId: options.pendingMessageId,
                            attachments,
                            model: {
                                id: configured.summary.modelDbId,
                                provider_id: configured.summary.providerId,
                                model_id: configured.summary.modelId,
                            },
                            sessionId: options.sessionId ?? null,
                            taskId: scope.taskId,
                            executionMode: options.executionMode ?? 'foreground',
                            promptSnapshot: snapshot,
                            maxRetries: 5,
                            buildSessionTitle: (prompt) => {
                                const normalized = collapseWhitespace(prompt);
                                return normalized
                                    ? truncateText(normalized, 40)
                                    : sessions.messages.tt('新会话');
                            },
                        });
                        const persistence = createCorePersistenceAdapter({
                            persistence: projector,
                            messages: messageAdapter,
                            modelIdentity: (key) => identity(scope.taskId, key),
                            languageContext: snapshot.modelLanguageContext,
                            errorText: sessions.messages.errorText,
                            legacyExecutedToolIds: () => [...executed],
                            bindToolAudit: (isCurrent) =>
                                createToolAudit({ taskId: scope.taskId, isCurrent }),
                        });
                        record = {
                            userMessageId: options.userMessageId,
                            initialUserContent: [...desktopMessages]
                                .reverse()
                                .find((message) => message.role === 'user')?.content,
                            pendingMessageId: options.pendingMessageId,
                            pendingDelivery,
                            signal: scope.signal,
                            modelKey,
                            projector,
                            persistence,
                            messages: messageAdapter,
                            snapshot,
                            fragments: liveSnapshot.fragments,
                            executed,
                            nextRequestIndex: 0,
                        };
                        resources.set(scope.taskId, record);
                    } catch (error) {
                        messageAdapter.dispose();
                        throw error;
                    }
                }
                const prepared = await prepareBindings(
                    scope.taskId,
                    record,
                    lease,
                    scope.modelSwitchCount
                );
                record.modelKey = modelKey;
                return { ...prepared, messages };
            } catch (error) {
                lease.release();
                throw error;
            }
        },
        persistence(request) {
            const record = resources.get(request.taskId);
            if (!record) throw new Error('AGENT_REQUEST_NOT_FOUND');
            const source = record.persistence;
            return {
                ...source,
                async start(checkpoint, scope) {
                    try {
                        const started = await source.start(checkpoint, scope);
                        if (started.currentUserOrigin && record.initialUserContent !== undefined) {
                            const origin = record.messages.toDesktopSource(
                                started.currentUserOrigin
                            );
                            record.messages.bindUserMessageSource(
                                record.initialUserContent,
                                origin
                            );
                            record.initialUserSourceId = origin.id;
                            record.initialUserContent = undefined;
                        }
                        return started;
                    } catch (error) {
                        if (record.pendingMessageId) reportQueuedMessageStartFailure();
                        throw error;
                    }
                },
                async retry(retry, scope) {
                    let saved = false;
                    try {
                        await source.retry(retry, scope);
                        saved = true;
                    } finally {
                        observe(request.taskId, (output) => output.retry?.(retry.terminal, saved));
                    }
                },
                async finish(terminal, scope) {
                    let saved = false;
                    try {
                        await source.finish(terminal, scope);
                        saved = true;
                        if (terminal.status === 'completed') {
                            try {
                                await bindings.recordUse(request.taskId, record.modelKey);
                            } catch (error) {
                                report('[Agent] Failed to record model use', error);
                            }
                        }
                    } finally {
                        observe(request.taskId, (output) => output.terminal(terminal, saved));
                    }
                },
            };
        },
    };

    async function prepareBindings(
        taskId: string,
        record: TaskResources,
        lease: TaskModelLease,
        modelSwitchCount: number
    ): Promise<AgentPreparedTurn> {
        const configured = lease.model;
        const currentModel = {
            key: lease.key,
            id: configured.summary.modelDbId,
            provider_id: configured.summary.providerId,
            provider_name: configured.summary.providerName,
            model_id: configured.summary.modelId,
            name: configured.summary.modelName,
            supportsImages: configured.capabilities.supportsImages,
        };
        const snapshot = await snapshotTools({
            preparation: { taskId, currentModel },
            signal: record.signal,
            enabled: configured.capabilities.supportsTools,
            beginAudit: record.persistence.beginToolAudit,
            excludedNames: modelSwitchCount >= 4 ? ['builtin__upgrade_model'] : [],
        });
        record.signal.throwIfAborted();
        const tools = createCoreToolsAdapter({
            snapshot,
            model: currentModel,
            messages: record.messages,
            historyTarget: (key) => {
                const sessionId = record.projector.getSessionId();
                if (sessionId === null) throw new Error('TOOL_RESULT_TARGET_MISSING');
                return { sessionId, messageId: record.messages.messageId(key) };
            },
            present: (event, scope) => present(taskId, scope.attemptToken, event),
            materialize: (attachments, signal) =>
                buildAttachmentParts([...attachments], {
                    includeAnchorText: false,
                    inlineFileContents: true,
                    signal,
                    diagnostics,
                }),
            executed: (name) => {
                if (name.startsWith('builtin__'))
                    record.executed.add(name.slice('builtin__'.length));
            },
        });
        const model: AgentModel = {
            key: lease.key,
            connectionKey: lease.connection.connectionKey,
            model: configured.summary.modelId,
            contextLimit: configured.capabilities.contextLimit,
            outputLimit: configured.capabilities.outputLimit,
            supportsTools: configured.capabilities.supportsTools,
            supportsReasoning: configured.capabilities.supportsReasoning,
            reasoningOptions: structuredClone(configured.capabilities.reasoningOptions),
            preserveReasoningCache: configured.capabilities.preserveReasoningCache,
        };
        return {
            model,
            tools,
            messages: [],
            promptFragments: record.fragments,
            pendingMessages: record.pendingDelivery
                ? createPendingMessageDelivery({
                      queue: record.pendingDelivery,
                      projector: record.projector,
                      adapter: record.messages,
                      capabilities: configured.capabilities,
                      diagnostics,
                  })
                : undefined,
            release: lease.release,
            async *stream(request: AiRequestOptions, scope: AgentScope) {
                scope.signal.throwIfAborted();
                if (record.transportAttempt !== scope.attemptToken) {
                    record.transportAttempt = scope.attemptToken;
                    record.nextRequestIndex = scope.iteration;
                }
                const stream = createCoreModelStream({
                    protect: input.privacy
                        ? createDesktopPrivacyStream({
                              settings: input.privacy,
                              review: {
                                  privacyReviewGeneration: input.privacy.getReviewGeneration,
                                  publishPrivacyReview: input.privacy.publishPrivacyReview,
                              },
                              context: () => ({
                                  sessionId: record.projector.getSessionId() ?? undefined,
                                  modelName: configured.summary.modelName,
                              }),
                              restored: (content, spans, generation) => {
                                  record.pendingRestoration = { content, spans, generation };
                              },
                          })
                        : undefined,
                    connection: lease.connection,
                    messages: record.messages,
                    languageContext: record.snapshot.modelLanguageContext,
                    nextRequestIndex: () => record.nextRequestIndex++,
                    saveManifest: async (manifest) => {
                        scope.signal.throwIfAborted();
                        if (!record.persistence.isCurrentScope(scope))
                            throw new Error('PERSISTENCE_SCOPE_STALE');
                        await record.projector.syncDeliveryManifestRequest(
                            JSON.stringify(manifest)
                        );
                    },
                });
                const presentDrafts = (projected: AiStreamChunk) => {
                    if (
                        scope.signal.aborted ||
                        resources.get(taskId) !== record ||
                        !record.persistence.isCurrentScope(scope) ||
                        disposed
                    )
                        return;
                    for (const delta of projected.toolCallDeltas ?? [])
                        if (delta.name === 'builtin__show_widget' && delta.callId) {
                            const draft = drafts.build(delta.callId, delta.argumentsBuffer);
                            if (draft)
                                present(taskId, scope.attemptToken, {
                                    type: 'widget_upsert',
                                    ...draft,
                                });
                        }
                };
                const projectWidget = createPublicWidgetStream({
                    signal: scope.signal,
                    publish: presentDrafts,
                    reportError: (error) => report('[Agent] Widget draft projection failed', error),
                });
                const leaveStream = observe(taskId, (output) => output.beginStream?.());
                try {
                    if (!record.userSourcePresented && record.initialUserSourceId) {
                        record.userSourcePresented = true;
                        for (const listener of presentation.get(taskId) ?? [])
                            listener(
                                {
                                    content: '',
                                    done: false,
                                    userMessageSource: {
                                        messageId: record.userMessageId,
                                        sourceId: record.initialUserSourceId,
                                    },
                                },
                                scope.attemptToken
                            );
                    }
                    for await (const chunk of stream(request)) {
                        scope.signal.throwIfAborted();
                        observe(taskId, (output) => output.stream(chunk));
                        presentDrafts(await projectWidget(chunk));
                        scope.signal.throwIfAborted();
                        // Widget filtering is presentation-only. Core must validate every raw tool call.
                        yield chunk;
                        record.pendingRestoration = undefined;
                    }
                } finally {
                    record.pendingRestoration = undefined;
                    projectWidget.dispose();
                    observe(taskId, () => leaveStream?.());
                }
            },
        };
    }

    return Object.freeze({
        host,
        stage(
            options: StartSessionTaskOptions,
            pendingDelivery?: AgentPendingDelivery
        ): AgentStartInput {
            if (disposed) throw new Error('AGENT_DISPOSED');
            const requestKey = crypto.randomUUID();
            staged.set(requestKey, {
                pendingDelivery,
                options: {
                    ...options,
                    attachments: options.attachments
                        ? structuredClone(options.attachments)
                        : undefined,
                    inputSnapshot: options.inputSnapshot
                        ? structuredClone(options.inputSnapshot)
                        : undefined,
                },
            });
            return {
                prompt: options.prompt,
                requestKey,
                signal: options.signal,
                mode: options.executionMode,
                conversationKey:
                    options.sessionId === undefined ? undefined : `session:${options.sessionId}`,
            };
        },
        releaseStaged(request: AgentStartInput) {
            if (request.requestKey) staged.delete(request.requestKey);
        },
        observe(event: AgentEvent) {
            observe(event.taskId, (output) => output.event(event));
        },
        releaseTask,
        sessions: {
            ...sessions,
            onTextAppended(
                taskId: string,
                append: { partId: string; offset: number; content: string }
            ) {
                const record = resources.get(taskId);
                const pending = record?.pendingRestoration;
                if (record) record.pendingRestoration = undefined;
                if (pending && pending.content === append.content)
                    input.privacy?.publishRestoredPrivacyReview(
                        append.partId,
                        append.offset,
                        pending.spans,
                        pending.generation
                    );
            },
            modelSummary: (taskId: string, key: string) => bindings.describe(taskId, key),
            subscribePresentation(taskId: string, listener: PresentationListener) {
                if (disposed) throw new Error('AGENT_DISPOSED');
                let listeners = presentation.get(taskId);
                if (!listeners) {
                    listeners = new Set();
                    presentation.set(taskId, listeners);
                }
                listeners.add(listener);
                return () => {
                    listeners.delete(listener);
                    if (!listeners.size) presentation.delete(taskId);
                };
            },
        },
        async dispose() {
            if (disposed) return;
            disposed = true;
            staged.clear();
            const results = await Promise.allSettled(
                [...new Set([...resources.keys(), ...outputs.keys()])].map(releaseTask)
            );
            disposeModels();
            presentation.clear();
            const failures = results.flatMap((result) =>
                result.status === 'rejected' ? [result.reason] : []
            );
            if (failures.length)
                throw new AggregateError(failures, 'AGENT_RESOURCE_CLEANUP_FAILED');
        },
    });
}
