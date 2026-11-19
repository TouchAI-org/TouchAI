import { mockWindows } from '@tauri-apps/api/mocks';
import { DOMWrapper, flushPromises } from '@vue/test-utils';
import { createPinia, disposePinia } from 'pinia';
import { createApp } from 'vue';

import { analyticsPreferencesApiKey } from '@/app/api/analytics/preferences';
import { productAnalyticsApiKey } from '@/app/api/analytics/product';
import { modelAdministrationApiKey } from '@/app/api/models/administration';
import { modelDiscoveryApiKey } from '@/app/api/models/discovery';
import { modelMetadataApiKey } from '@/app/api/models/metadata';
import { dataManagementApiKey } from '@/app/api/settings/dataManagement';
import { settingsApiKey } from '@/app/api/settings/preferences';
import { toolSettingsApiKey } from '@/app/api/settings/tools';
import { toolsAdministrationApiKey } from '@/app/api/tools/administration';
import { computerAdministrationApiKey } from '@/app/api/tools/computer';
import { mcpApiKey } from '@/app/api/tools/mcp';
import { mcpAdministrationApiKey } from '@/app/api/tools/mcpAdministration';
import { updatePreferencesApiKey, updatesApiKey } from '@/app/api/updates';
import { initializeAgentWindow } from '@/app/bootstrap/agent';
import { useSettingsStore } from '@/stores/settings';
import { useToolSettingsStore } from '@/stores/toolSettings';

import { createAgentWindowFixture } from './agentWindow';
import { createTestWindowPresentation } from './windowPresentation';

/** Real bootstrap, directed settings clients, and shipped SQLite for settings UI behavior. */
export async function createSettingsPanelFixture(
    input: {
        values?: Record<string, string>;
        query?: Parameters<typeof createAgentWindowFixture>[2];
    } = {}
) {
    const fixture = createAgentWindowFixture('main', undefined, input.query);
    for (const [key, value] of Object.entries(input.values ?? {})) {
        fixture.database.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, value);
    }
    await fixture.window.ready;
    await fixture.window.capabilities.waitForAgent();
    await fixture.window.settings.initialize();
    mockWindows('settings');
    const client = initializeAgentWindow();
    const presentation = await createTestWindowPresentation();
    presentation.install();
    await client.settings.initialize();
    const pinia = createPinia();
    const app = createApp({ render: () => null });
    app.use(pinia);
    presentation.provide(app);
    app.provide(settingsApiKey, client.settings);
    app.provide(productAnalyticsApiKey, client.productAnalytics);
    app.provide(analyticsPreferencesApiKey, client.analyticsPreferences!);
    app.provide(dataManagementApiKey, client.dataManagement!);
    app.provide(modelAdministrationApiKey, client.modelAdministration!);
    app.provide(modelMetadataApiKey, client.metadata);
    app.provide(modelDiscoveryApiKey, client.models);
    app.provide(toolSettingsApiKey, client.toolSettings!);
    app.provide(toolsAdministrationApiKey, client.tools);
    app.provide(computerAdministrationApiKey, client.computer);
    app.provide(mcpAdministrationApiKey, client.mcpAdministration!);
    app.provide(mcpApiKey, client.mcp);
    app.provide(updatesApiKey, client.updates);
    app.provide(updatePreferencesApiKey, client.updatePreferences!);
    const preferences = app.runWithContext(() => useSettingsStore(pinia));
    const tools = app.runWithContext(() => useToolSettingsStore(pinia));
    await preferences.initialize();
    await tools.initialize();
    return {
        ...fixture,
        client,
        pinia,
        preferences,
        tools,
        runWithContext: <T>(callback: () => T): T => app.runWithContext(callback),
        viewOptions: {
            attachTo: document.body,
            global: {
                plugins: [pinia],
                provide: {
                    [settingsApiKey as symbol]: client.settings,
                    [productAnalyticsApiKey as symbol]: client.productAnalytics,
                    [analyticsPreferencesApiKey as symbol]: client.analyticsPreferences!,
                    [dataManagementApiKey as symbol]: client.dataManagement!,
                    [modelAdministrationApiKey as symbol]: client.modelAdministration!,
                    [modelMetadataApiKey as symbol]: client.metadata,
                    [modelDiscoveryApiKey as symbol]: client.models,
                    [toolSettingsApiKey as symbol]: client.toolSettings!,
                    [toolsAdministrationApiKey as symbol]: client.tools,
                    [computerAdministrationApiKey as symbol]: client.computer,
                    [mcpAdministrationApiKey as symbol]: client.mcpAdministration!,
                    [mcpApiKey as symbol]: client.mcp,
                    [updatesApiKey as symbol]: client.updates,
                    [updatePreferencesApiKey as symbol]: client.updatePreferences!,
                },
            },
        },
        saved(key: string): string | undefined {
            return fixture.database.prepare('SELECT value FROM settings WHERE key = ?').get(key)
                ?.value as string | undefined;
        },
        async dispose() {
            disposePinia(pinia);
            presentation.window.dispose();
            await client.dispose();
            await fixture.window.dispose();
        },
    };
}

export async function openSettingsSelect(trigger: Pick<DOMWrapper<Element>, 'element'>) {
    trigger.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushPromises();
    return [...document.querySelectorAll('[role="option"]')].map(
        (element) => new DOMWrapper(element)
    );
}

export async function chooseSettingsOption(
    trigger: Pick<DOMWrapper<Element>, 'element'>,
    label: string
) {
    const options = await openSettingsSelect(trigger);
    const option = options.find((candidate) => candidate.text().startsWith(label));
    if (!option) throw new Error(`Missing selectable option: ${label}`);
    option.element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    await flushPromises();
}
