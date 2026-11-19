import { mockWindows } from '@tauri-apps/api/mocks';
import { createPinia, disposePinia } from 'pinia';
import { createApp } from 'vue';

import { settingsApiKey } from '@/app/api/settings/preferences';
import { toolSettingsApiKey } from '@/app/api/settings/tools';
import { assembleSettingsWindow } from '@/app/composition/settings';
import { useSettingsStore } from '@/stores/settings';
import { useToolSettingsStore } from '@/stores/toolSettings';

import { openMigratedDatabase, routeQueriesTo } from '../database/sqliteHarness';
import { mockTauriCommand } from './tauri';

export function createSettingsStorageFixture(
    input: {
        values?: Record<string, string | null>;
        query?: Parameters<typeof routeQueriesTo>[1];
    } = {}
) {
    const database = openMigratedDatabase();
    routeQueriesTo(database, input.query);
    const values = {
        clear() {
            database.exec('DELETE FROM settings');
        },
        get(key: string) {
            const row = database.prepare('SELECT value FROM settings WHERE key = ?').get(key);
            return row?.value as string | undefined;
        },
        set(key: string, value: string | null) {
            if (value === null) database.prepare('DELETE FROM settings WHERE key = ?').run(key);
            else
                database
                    .prepare(
                        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
                    )
                    .run(key, value);
            return values;
        },
    };
    for (const [key, value] of Object.entries(input.values ?? {})) values.set(key, value);
    return { database, values };
}

/** The same owner/client and injection boundary used by production bootstrap. */
export function createSettingsWindowFixture(
    input: {
        label?: string;
        values?: Record<string, string | null>;
        query?: Parameters<typeof routeQueriesTo>[1];
    } = {}
) {
    mockWindows('main');
    mockTauriCommand('is_autostart_enabled', false);
    const { database, values } = createSettingsStorageFixture(input);
    const owner = assembleSettingsWindow('main');
    const clients: ReturnType<typeof assembleSettingsWindow>[] = [];
    function createClient(label = 'settings') {
        mockWindows(label);
        const client = assembleSettingsWindow(label);
        clients.push(client);
        return client;
    }
    const window = !input.label || input.label === 'main' ? owner : createClient(input.label);
    const pinia = createPinia();
    const app = createApp({ render: () => null });
    app.use(pinia);
    app.provide(settingsApiKey, window.api);
    if (window.toolSettings) app.provide(toolSettingsApiKey, window.toolSettings);
    const store = () => app.runWithContext(() => useSettingsStore(pinia));
    const tools = () => app.runWithContext(() => useToolSettingsStore(pinia));
    const provide = {
        [settingsApiKey as symbol]: window.api,
        ...(window.toolSettings ? { [toolSettingsApiKey as symbol]: window.toolSettings } : {}),
    };
    return {
        database,
        values,
        owner,
        window,
        pinia,
        app,
        store,
        tools,
        createClient,
        viewOptions: { global: { plugins: [pinia], provide } },
        async initialize() {
            await owner.api.initialize();
            await window.api.initialize();
        },
        dispose() {
            disposePinia(pinia);
            for (const client of clients) client.dispose();
            owner.dispose();
        },
    };
}
