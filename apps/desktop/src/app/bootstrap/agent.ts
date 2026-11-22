import { AgentError } from '@touchai/agent-core/contracts';

import type { AgentApi, StartSessionTaskOptions } from '@/app/api/agent/contracts';
import { AiError, AiErrorCode } from '@/app/api/agent/errors';
import { assembleAnalyticsWindow } from '@/app/composition/analytics';
import type { DesktopMainAgentHost } from '@/app/composition/main';
import { assemblePrivacyWindow } from '@/app/composition/privacy';
import { assembleSettingsWindow } from '@/app/composition/settings';
import { assembleMainUpdates } from '@/app/composition/updates';
import { createStartupNotices } from '@/app/workflows/data-management/notices';
import { log } from '@/platform/diagnostics';
import { getNativeWindowLabel } from '@/platform/windows/execution';
import { awaitAbortable, combineAbortSignals } from '@/utils/abort';

import { createStartupCapabilities, type StartupCapabilities } from './capabilities';
import { createComputerAdministrationWindow } from './computerAdministration';
import { createDataManagementWindow } from './dataManagement';
import { createMcpWindow } from './mcp';
import { createModelAdministrationWindow } from './modelAdministration';
import { createModelDiscoveryWindow } from './modelDiscovery';
import { createModelMetadataWindow } from './modelMetadata';
import { createToolsAdministrationWindow } from './toolAdministration';
import { createUpdatesWindow } from './updates';

function publicError(error: unknown): unknown {
    if (error instanceof AiError) return error;
    if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        typeof error.code === 'string' &&
        Object.values(AiErrorCode).includes(error.code as AiErrorCode)
    ) {
        return new AiError(error.code as AiErrorCode, undefined, undefined, { cause: error });
    }
    if (error instanceof Error && error.name === 'AbortError')
        return new AiError(AiErrorCode.REQUEST_CANCELLED);
    return error;
}

/** Called by real bootstrap before mounting. Secondary windows never load the host entry. */
export function initializeAgentWindow(input: { capabilities?: StartupCapabilities } = {}) {
    const label = getNativeWindowLabel();
    const main = label === 'main';
    const lifetime = new AbortController();
    const capabilities = input.capabilities ?? createStartupCapabilities(log.warn);
    const preferences = assembleSettingsWindow(label);
    const privacy = assemblePrivacyWindow(preferences.privacySettings);
    const analytics = assembleAnalyticsWindow(label);
    const startupNotices = main
        ? createStartupNotices({ initializePreferences: preferences.api.initialize })
        : undefined;
    const updateOwner = main
        ? assembleMainUpdates({ settings: preferences.api, analytics: analytics.updates })
        : undefined;
    const updates = createUpdatesWindow({
        label,
        signal: lifetime.signal,
        owner: updateOwner?.controller,
        warn: (code) => log.warn('[Bootstrap] Updates unavailable', { code }),
    });
    let owner: DesktopMainAgentHost | undefined;
    const ready = main
        ? import('../composition/main').then((module) => {
              lifetime.signal.throwIfAborted();
              owner = module.assembleDesktopMainAgent({
                  analytics: analytics.sink,
                  settings: preferences.api,
                  privacy: privacy.api,
                  beforeStart: async () => {
                      await preferences.api.initialize();
                      await capabilities.waitForAgent();
                  },
              });
              capabilities.register('built-in-tools', owner.synchronize());
              capabilities.register('built-in-bash', owner.prewarmBash());
          })
        : Promise.resolve();
    void ready.catch((error: unknown) => {
        if (!lifetime.signal.aborted)
            log.error('[Bootstrap] Main agent host failed to initialize', error);
    });
    const requireOwner = () => {
        if (lifetime.signal.aborted) throw new AgentError('AGENT_DISPOSED');
        if (!main) throw new AgentError('MAIN_EXECUTION_HOST_REQUIRED');
        if (!owner) throw new AgentError('AGENT_HOST_UNAVAILABLE');
        return owner;
    };
    const discovery = createModelDiscoveryWindow({
        label,
        signal: lifetime.signal,
        discover: main
            ? async (providerId, signal) => {
                  await awaitAbortable(() => ready, signal);
                  return requireOwner().discoverModels(providerId, signal);
              }
            : undefined,
        warn: (code) => log.warn('[Bootstrap] Model discovery unavailable', { code }),
    });
    const metadata = createModelMetadataWindow({
        label,
        signal: lifetime.signal,
        owner: main
            ? async (signal) => {
                  await awaitAbortable(() => ready, signal);
                  return requireOwner().metadata;
              }
            : undefined,
        warn: (code) => log.warn('[Bootstrap] Model metadata unavailable', { code }),
    });
    const modelAdministration = createModelAdministrationWindow({
        label,
        signal: lifetime.signal,
        owner: main
            ? async (signal) => {
                  await awaitAbortable(() => ready, signal);
                  return requireOwner().modelAdministration;
              }
            : undefined,
        warn: (code) => log.warn('[Bootstrap] Model administration unavailable', { code }),
    });
    const dataManagement = createDataManagementWindow({
        label,
        signal: lifetime.signal,
        owner: main
            ? async (signal) => {
                  await awaitAbortable(() => ready, signal);
                  return requireOwner().dataManagement;
              }
            : undefined,
        warn: (code) => log.warn('[Bootstrap] Data management unavailable', { code }),
    });
    const mcp = createMcpWindow({
        label,
        signal: lifetime.signal,
        catalog: {
            async listServers() {
                if (!main)
                    return (await tools.mcpApi.findAllMcpServers()).map(
                        ({ id, name, enabled, version }) => ({ id, name, enabled, version })
                    );
                await awaitAbortable(() => ready, lifetime.signal);
                return requireOwner().mcpCatalog.listServers();
            },
            async listTools(serverId) {
                if (!main) return tools.mcpApi.findMcpToolsByServerId(serverId);
                await awaitAbortable(() => ready, lifetime.signal);
                return requireOwner().mcpCatalog.listTools(serverId);
            },
        },
        run: main
            ? async (operation, serverId, signal) => {
                  await awaitAbortable(() => ready, signal);
                  signal.throwIfAborted();
                  const connections = requireOwner().mcp;
                  if (operation === 'connect') await connections.connect(serverId!, 'user', signal);
                  else if (operation === 'disconnect') await connections.disconnect(serverId!);
                  return operation === 'statuses' ? connections.refresh() : [];
              }
            : undefined,
        warn: (code) => log.warn('[Bootstrap] MCP management unavailable', { code }),
    });
    const tools = createToolsAdministrationWindow({
        label,
        signal: lifetime.signal,
        externalAgents: main
            ? async (signal) => {
                  await awaitAbortable(() => ready, signal);
                  await awaitAbortable(() => capabilities.waitForAgent(), signal);
                  return requireOwner().externalAgentsAdministration;
              }
            : undefined,
        mcpQueries: main
            ? async (signal) => {
                  await awaitAbortable(() => ready, signal);
                  return requireOwner().mcpAdministration;
              }
            : undefined,
        queries: main
            ? async (signal) => {
                  await awaitAbortable(() => ready, signal);
                  await awaitAbortable(() => capabilities.waitForAgent(), signal);
                  return requireOwner().toolsAdministration;
              }
            : undefined,
        warn: (code) => log.warn('[Bootstrap] Tool administration unavailable', { code }),
    });
    const computer = createComputerAdministrationWindow({
        label,
        signal: lifetime.signal,
        owner: main
            ? async (signal) => {
                  await awaitAbortable(() => ready, signal);
                  await awaitAbortable(() => capabilities.waitForAgent(), signal);
                  return requireOwner().computerAdministration;
              }
            : undefined,
        warn: (code) => log.warn('[Bootstrap] Computer administration unavailable', { code }),
    });
    const start = async (options: StartSessionTaskOptions, background = false) => {
        let combined: ReturnType<typeof combineAbortSignals> | undefined;
        try {
            if (lifetime.signal.aborted) throw new AgentError('AGENT_DISPOSED');
            if (!main) throw new AgentError('MAIN_EXECUTION_HOST_REQUIRED');
            combined = combineAbortSignals([options.signal, lifetime.signal]);
            const { signal, dispose } = combined;
            await awaitAbortable(() => ready, signal);
            const sessions = requireOwner().sessions;
            const started = await (background
                ? sessions.startBackgroundTask({ ...options, signal })
                : sessions.startTask({ ...options, signal }));
            const completion = started.completion
                .catch((error: unknown) => {
                    throw publicError(error);
                })
                .finally(dispose);
            // Background callers may observe the task before awaiting its completion.
            void completion.catch(() => undefined);
            return { ...started, completion };
        } catch (error) {
            combined?.dispose();
            throw publicError(error);
        }
    };
    const api = Object.freeze<AgentApi>({
        startTask: (options) => start(options),
        startBackgroundTask: (options) => start(options, true),
        cancelTask: (taskId, options) => owner?.sessions.cancelTask(taskId, options) ?? false,
        enqueueTaskUserMessage: (...args) =>
            owner?.sessions.enqueueTaskUserMessage(...args) ?? null,
        enqueueSessionUserMessage: (...args) =>
            owner?.sessions.enqueueSessionUserMessage(...args) ?? null,
        updateTaskUserMessage: (...args) => owner?.sessions.updateTaskUserMessage(...args) ?? false,
        updateSessionUserMessage: (...args) =>
            owner?.sessions.updateSessionUserMessage(...args) ?? false,
        setTaskUserMessageEditing: (...args) =>
            owner?.sessions.setTaskUserMessageEditing(...args) ?? false,
        setSessionUserMessageEditing: (...args) =>
            owner?.sessions.setSessionUserMessageEditing(...args) ?? false,
        clearUserMessageEditing: (...args) =>
            owner?.sessions.clearUserMessageEditing(...args) ?? false,
        removeTaskUserMessage: (...args) => owner?.sessions.removeTaskUserMessage(...args) ?? false,
        removeSessionUserMessage: (...args) =>
            owner?.sessions.removeSessionUserMessage(...args) ?? false,
        promoteTaskUserMessage: (...args) =>
            owner?.sessions.promoteTaskUserMessage(...args) ?? false,
        promoteSessionUserMessage: (...args) =>
            owner?.sessions.promoteSessionUserMessage(...args) ?? false,
        reorderTaskQueuedMessages: (...args) =>
            owner?.sessions.reorderTaskQueuedMessages(...args) ?? false,
        reorderSessionQueuedMessages: (...args) =>
            owner?.sessions.reorderSessionQueuedMessages(...args) ?? false,
        clearTaskUserMessages: (...args) => owner?.sessions.clearTaskUserMessages(...args) ?? false,
        clearSessionUserMessages: (...args) =>
            owner?.sessions.clearSessionUserMessages(...args) ?? false,
        updateTaskUserMessageModel: (...args) =>
            owner?.sessions.updateTaskUserMessageModel(...args) ?? false,
        async restoreSessionQueue(sessionId) {
            await ready;
            return requireOwner().sessions.restoreSessionQueue(sessionId);
        },
        resumeSessionQueue: (sessionId) => owner?.sessions.resumeSessionQueue(sessionId),
        approveTaskToolCall: (taskId, callId, decisionId) =>
            owner?.sessions.approveTaskToolCall(taskId, callId, decisionId) ?? false,
        rejectTaskToolCall: (taskId, callId, decisionId) =>
            owner?.sessions.rejectTaskToolCall(taskId, callId, decisionId) ?? false,
        settleTaskUserQuestion: (taskId, callId, answers, decisionId) =>
            owner?.sessions.settleTaskUserQuestion(taskId, callId, answers, decisionId) ?? false,
        attachSessionView: (sessionId) => owner?.sessions.attachSessionView(sessionId) ?? null,
        getTaskSnapshot: (taskId) => owner?.sessions.getTaskSnapshot(taskId) ?? null,
        subscribeTask: (taskId, listener) =>
            requireOwner().sessions.subscribeTask(taskId, listener),
        getSessionStatus: (sessionId) => owner?.sessions.getSessionStatus(sessionId) ?? null,
        listActiveTasks: () => owner?.sessions.listActiveTasks() ?? [],
        async getSession(sessionId) {
            await ready;
            return requireOwner().queries.getSession(sessionId);
        },
        async loadSession(sessionId) {
            await ready;
            return requireOwner().queries.loadSession(sessionId);
        },
    });
    let disposal: Promise<void> | undefined;
    return Object.freeze({
        privacy: privacy.api,
        api,
        startup: startupNotices ? Object.freeze({ consume: startupNotices.consume }) : undefined,
        productAnalytics: analytics.product,
        analyticsPreferences: analytics.preferences,
        updates: updates.api,
        updatePreferences: updates.preferences,
        models: discovery.api,
        modelAdministration: label === 'settings' ? modelAdministration.api : undefined,
        dataManagement: label === 'settings' ? dataManagement.api : undefined,
        metadata: metadata.api,
        mcp: mcp.api,
        mcpAdministration: label === 'settings' ? tools.mcpApi : undefined,
        externalAgentsAdministration: label === 'settings' ? tools.externalAgentsApi : undefined,
        tools: tools.api,
        computer: computer.api,
        settings: preferences.api,
        toolSettings: preferences.toolSettings,
        ready,
        capabilities,
        startAutomaticUpdateChecks() {
            if (!main || lifetime.signal.aborted)
                throw new AgentError('MAIN_EXECUTION_HOST_REQUIRED');
            updateOwner!.startAutomaticChecks();
        },
        async initializeModelMetadata(): Promise<void> {
            await awaitAbortable(() => ready, lifetime.signal);
            await requireOwner().metadata.initialize();
        },
        async autoConnectMcp(): Promise<void> {
            if (!main) throw new AgentError('MAIN_EXECUTION_HOST_REQUIRED');
            await awaitAbortable(() => ready, lifetime.signal);
            await requireOwner().mcp.autoConnect();
        },
        dispose(): Promise<void> {
            if (disposal) return disposal;
            lifetime.abort();
            capabilities.dispose();
            discovery.dispose();
            modelAdministration.dispose();
            dataManagement.dispose();
            metadata.dispose();
            mcp.dispose();
            tools.dispose();
            computer.dispose();
            startupNotices?.dispose();
            privacy.dispose();
            preferences.dispose();
            analytics.dispose();
            updates.dispose();
            const updateDisposal = updateOwner?.dispose();
            disposal = Promise.all([
                updateDisposal,
                ready.catch(() => undefined).then(() => owner?.dispose()),
            ]).then(() => undefined);
            return disposal;
        },
    });
}
