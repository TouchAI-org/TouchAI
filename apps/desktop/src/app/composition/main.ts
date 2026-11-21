import { createAgent } from '@touchai/agent-core';
import type { AgentEvent, AgentHost, AgentStartInput } from '@touchai/agent-core/contracts';

import { AiError, AiErrorCode } from '@/app/api/agent/errors';
import { createAgentAnalytics } from '@/app/workflows/agent/analytics';
import { createAgentHistoryQueries } from '@/app/workflows/agent/history';
import { createMainAgentWorkflow } from '@/app/workflows/agent/host';
import { createTaskModelBindings } from '@/app/workflows/agent/modelBindings';
import { createTaskStatusPublisher } from '@/app/workflows/agent/notifications';
import { createMainTaskObservations } from '@/app/workflows/agent/observations';
import { tt } from '@/i18n';
import { createAgentSessions } from '@/modules/agent';
import type {
    AgentPendingDelivery,
    AgentSessionHost,
    StartSessionTaskOptions,
} from '@/modules/agent/contracts';
import type { AnalyticsSink } from '@/modules/analytics';
import { createModelSelection } from '@/modules/models';
import { EventTriggerRegistry, TaskScheduler } from '@/modules/scheduler';
import type { SettingsApi } from '@/modules/settings/public';
import { readMcpServerNames } from '@/modules/tools';
import { log } from '@/platform/diagnostics';
import { requireMainExecutionHost } from '@/platform/windows/execution';

import { assembleDataManagement } from './dataManagement';
import { assembleModels } from './models';
import { assembleMainTools } from './tools';

export interface MainAgentAssembly {
    host: AgentHost;
    stage(
        options: StartSessionTaskOptions,
        pendingDelivery?: AgentPendingDelivery
    ): AgentStartInput;
    releaseStaged(input: AgentStartInput): void;
    observe(event: AgentEvent): void;
    releaseTask(taskId: string): Promise<void>;
    dispose(): Promise<void>;
    sessions: Omit<AgentSessionHost, 'execution'>;
}

/** This is the sole production Core creation entry. Clients receive safe session capabilities. */
export function assembleAgentHost(input: MainAgentAssembly) {
    requireMainExecutionHost();
    const stage = input.stage.bind(input);
    const releaseStaged = input.releaseStaged.bind(input);
    const observe = input.observe.bind(input);
    const releaseTask = input.releaseTask.bind(input);
    const disposeHost = input.dispose.bind(input);
    const report = input.sessions.reportObserverError?.bind(input.sessions);
    const core = createAgent(input.host);
    const sessions = createAgentSessions({
        ...input.sessions,
        execution: {
            start(options, pendingDelivery) {
                const staged = stage(options, pendingDelivery);
                let task: ReturnType<typeof core.start>;
                try {
                    task = core.start(staged);
                } catch (error) {
                    releaseStaged(staged);
                    throw error;
                }
                const stop = core.subscribe(task.taskId, observe);
                const completion = task.completion.finally(async () => {
                    stop();
                    releaseStaged(staged);
                    try {
                        await releaseTask(task.taskId);
                    } catch (error) {
                        try {
                            report?.(error);
                        } catch {
                            /* Passive diagnostics cannot change a committed completion. */
                        }
                    }
                });
                return { taskId: task.taskId, completion };
            },
            subscribe: core.subscribe,
            cancel: core.cancel,
            reply: core.reply,
        },
    });
    let disposed = false;
    return Object.freeze({
        sessions,
        async dispose() {
            if (disposed) return;
            disposed = true;
            try {
                await sessions.dispose();
            } finally {
                try {
                    await core.dispose();
                } finally {
                    await disposeHost();
                }
            }
        },
    });
}

/** Production assembly. The bootstrap path and every session command use this same host. */
export function assembleDesktopMainAgent(input: {
    analytics: AnalyticsSink;
    beforeStart(): Promise<void>;
    settings: Pick<SettingsApi, 'initialize' | 'readEffectiveValue' | 'mutate'>;
}) {
    requireMainExecutionHost();
    const dataManagement = assembleDataManagement();
    const connections = assembleModels();
    const bindings = createTaskModelBindings({ selection: createModelSelection(), connections });
    const settings = Object.freeze({
        initialize: input.settings.initialize.bind(input.settings),
        readEffectiveValue: input.settings.readEffectiveValue.bind(input.settings),
        mutate: input.settings.mutate.bind(input.settings),
    });
    const tools = assembleMainTools({
        models: {
            resolve: bindings.resolveTarget,
            isAvailable: bindings.isAvailable,
            complete: bindings.complete,
        },
        settings: {
            async read(key) {
                await settings.initialize();
                const value = await settings.readEffectiveValue(key);
                if (
                    typeof value !== 'string' &&
                    typeof value !== 'number' &&
                    typeof value !== 'boolean'
                ) {
                    throw new Error('SETTING_VALUE_UNAVAILABLE');
                }
                return value;
            },
            async mutate(key, value) {
                await settings.initialize();
                return settings.mutate(key, value);
            },
        },
    });
    const queries = createAgentHistoryQueries({
        tools: tools.presentation,
        readServerNames: readMcpServerNames,
        tt,
        error: log.error,
    });
    const notifications = createTaskStatusPublisher();
    const analytics = createAgentAnalytics(input.analytics);
    const workflow = createMainAgentWorkflow({
        models: bindings,
        disposeModels: bindings.dispose,
        tools: tools.tools,
        sessions: {
            beforeStart: input.beforeStart,
            loadHistory: async (sessionId) => (await queries.loadSession(sessionId)).history,
            messages: {
                tt,
                errorText: (code) =>
                    Object.values(AiErrorCode).includes(code as AiErrorCode)
                        ? new AiError(code as AiErrorCode).getDisplayMessage()
                        : code,
                retryText: (attempt, maxRetries) =>
                    tt('重试中...({attempt}/{maxRetries})', { attempt, maxRetries }),
            },
            tools: tools.presentation,
            publishStatus: notifications.publish,
            reportObserverError: log.warn,
        },
        diagnostics: log,
        createObservations: (task, identity) =>
            createMainTaskObservations(
                { ...task, releaseNotification: () => notifications.release(task.taskId) },
                identity,
                analytics.createRequest
            ),
        releaseActivity: tools.computer.endActivity,
    });
    const assembly = assembleAgentHost(workflow);
    const events = new EventTriggerRegistry(log.warn);
    const scheduler = new TaskScheduler({
        diagnostics: log,
        listen: events.setupEventTrigger.bind(events),
        run: async (request) => {
            const task = await assembly.sessions.startBackgroundTask(request);
            await task.completion;
        },
    });
    return Object.freeze({
        sessions: assembly.sessions,
        queries,
        toolsAdministration: tools.administration,
        mcpAdministration: tools.mcpAdministration,
        mcpCatalog: tools.mcpCatalog,
        computerAdministration: Object.freeze({
            isEnabled: tools.computer.isEnabled,
            setEnabled: tools.computer.setEnabled,
            loadGroups: tools.computer.loadGroups,
            setGroupEnabled: tools.computer.setGroupEnabled,
            loadDriver: tools.computer.loadDriver,
            selectDriver: tools.computer.selectDriver,
            loadDriverDirectory: tools.computer.loadDriverDirectory,
            saveDriverDirectory: tools.computer.saveDriverDirectory,
            loadSettings: tools.computer.loadSettings,
            saveSettings: tools.computer.saveSettings,
            status: tools.computer.status,
            prepare: tools.computer.prepare,
            checkUpdate: tools.computer.checkUpdate,
            installUpdate: tools.computer.installUpdate,
            remove: tools.computer.remove,
            applySettings: tools.computer.applySavedSettings,
            setRecording: tools.computer.setRecording,
            setRecordingEnabled: tools.computer.setRecordingEnabled,
            loadRecordingDirectory: tools.computer.loadRecordingDirectory,
            saveRecordingDirectory: tools.computer.saveRecordingDirectory,
        }),
        scheduler,
        discoverModels: connections.discoverModels,
        modelAdministration: connections.administration,
        metadata: connections.metadata,
        dataManagement,
        mcp: {
            connect: tools.mcp.connect,
            disconnect: tools.mcp.disconnect,
            refresh: tools.mcp.refresh,
            autoConnect: tools.mcp.autoConnect,
        },
        synchronize: tools.synchronize,
        prewarmBash: tools.prewarmBash,
        async dispose() {
            // Close configuration admission before waiting for active tasks and native effects.
            void connections.administration.dispose();
            void dataManagement.dispose();
            scheduler.dispose();
            try {
                await assembly.dispose();
            } finally {
                try {
                    await tools.dispose();
                } finally {
                    notifications.dispose();
                    try {
                        await connections.dispose();
                    } finally {
                        await dataManagement.dispose();
                    }
                }
            }
        },
    });
}

export type DesktopMainAgentHost = ReturnType<typeof assembleDesktopMainAgent>;
