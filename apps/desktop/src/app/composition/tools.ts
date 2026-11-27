import { AppEvent, eventService } from '@/app/workflows/windows/events';
import { createWidgetMarkupInspector } from '@/components/widgets/inspection';
import { getLocale, t, tt } from '@/i18n';
import { createAttachment, createPersistedAttachmentFromData } from '@/modules/attachments';
import { discoverSkills, loadSelectedSkills } from '@/modules/skills';
import type { ToolModelCapabilities, ToolSettingsCapabilities } from '@/modules/tools';
import {
    createActivateSkillTools,
    createAskUserTools,
    createBashOperations,
    createBashTools,
    createBrowserTools,
    createBuiltinAdministration,
    createBuiltinRegistrations,
    createComputerControl,
    createComputerUseTools,
    createExternalAgents,
    createFileSearchTools,
    createMcpConnections,
    createMcpFormatting,
    createReadTools,
    createSettingTools,
    createShowWidgetTools,
    createToolFormatting,
    createToolPresentation,
    createTools,
    createUpgradeModelTools,
    createWebFetchTools,
    createWebSearchTools,
    readWebSearchConfiguration,
    SHOW_WIDGET_EXTERNAL_RESOURCE_SELECTOR,
} from '@/modules/tools';
import { createMcpAdministration, createMcpCatalog } from '@/modules/tools';
import { log } from '@/platform/diagnostics';

export function assembleMainTools(input: {
    models: ToolModelCapabilities;
    settings: ToolSettingsCapabilities;
}) {
    const messages = {
        t: (key: string, values?: Record<string, string | number>) =>
            t(key as Parameters<typeof t>[0], values),
        tt,
    };
    const resources = { create: createPersistedAttachmentFromData };
    const formatting = createMcpFormatting(messages, resources);
    const computer = createComputerControl({
        locale: getLocale,
        onStopped: (listener) => eventService.on(AppEvent.COMPUTER_USE_STOPPED, listener),
        warn: log.warn,
    });
    const mcp = createMcpConnections({ messages, resources, diagnostics: log });
    const externalAgents = createExternalAgents({ messages });
    const descriptors = [
        ...createActivateSkillTools({
            messages,
            skills: {
                discover: discoverSkills,
                load: async (selected) =>
                    (await loadSelectedSkills(selected, 'model_tool')).map((skill) => ({
                        name: skill.name,
                        path: skill.path,
                        hash: skill.hash,
                        contextText: skill.contextText,
                    })),
            },
        }),
        ...createAskUserTools(messages),
        ...createBashTools({ messages, warn: log.warn }),
        ...createBrowserTools({ messages }),
        ...createComputerUseTools({
            control: computer,
            messages,
            images: {
                extract: (content, context) =>
                    formatting.extractMcpToolAttachments(
                        { success: true, is_error: false, content },
                        {
                            toolCallId: context.callId,
                            toolName: 'computer_use',
                        }
                    ),
            },
            warn: log.warn,
        }),
        ...createFileSearchTools({ messages }),
        ...createReadTools({ messages, attachments: { create: createAttachment } }),
        ...createSettingTools({ messages, settings: input.settings, warn: log.warn }),
        ...createShowWidgetTools({
            messages,
            markup: createWidgetMarkupInspector(SHOW_WIDGET_EXTERNAL_RESOURCE_SELECTOR),
        }),
        ...createUpgradeModelTools({ messages, models: input.models }),
        ...createWebFetchTools({ messages, configuration: { read: readWebSearchConfiguration } }),
        ...createWebSearchTools({
            configuration: { read: readWebSearchConfiguration },
            activity: (event) => {
                void eventService.emit(AppEvent.WEB_SEARCH_ACTIVITY, event).catch(() => {
                    log.warn('[WebSearch] Could not update the search animation');
                });
            },
        }),
    ];
    const builtins = createBuiltinRegistrations(descriptors, externalAgents.builtinRegistrations);
    const tools = createTools({
        registrations: builtins.registrations,
        mcp,
        formatError: createToolFormatting(messages).formatError,
    });
    const presentation = createToolPresentation(descriptors, messages);
    const bash = createBashOperations(messages);
    const unsubscribe = mcp.subscribe((event) => {
        void eventService
            .emit(AppEvent.MCP_STATUS, {
                serverId: event.serverId,
                status: event.status,
                ...(event.error === null ? {} : { error: event.error }),
            })
            .catch(() => undefined);
    });
    return Object.freeze({
        tools,
        presentation,
        computer,
        mcp,
        administration: createBuiltinAdministration(),
        mcpAdministration: createMcpAdministration(),
        mcpCatalog: createMcpCatalog(),
        externalAgentsAdministration: externalAgents.administration,
        synchronize: builtins.synchronize,
        prewarmBash: bash.prewarmBashToolRuntime,
        async dispose() {
            tools.dispose();
            externalAgents.dispose();
            unsubscribe();
            const results = await Promise.allSettled([mcp.dispose(), computer.dispose()]);
            const failures = results.flatMap((result) =>
                result.status === 'rejected' ? [result.reason] : []
            );
            if (failures.length) throw new AggregateError(failures, 'TOOLS_HOST_CLEANUP_FAILED');
        },
    });
}
