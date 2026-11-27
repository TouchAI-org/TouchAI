import { mockWindows } from '@tauri-apps/api/mocks';
import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '@tests/database/sqliteHarness';
import { afterEach } from 'vitest';

import { assembleModels } from '@/app/composition/models';
import { assembleSettingsWindow } from '@/app/composition/settings';
import { assembleMainTools } from '@/app/composition/tools';
import { createTaskModelBindings } from '@/app/workflows/agent/modelBindings';
import { createModelSelection } from '@/modules/models';

import { mockTauriCommand } from './tauri';

const releases: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const release of releases.splice(0)) await release();
    closeTestDatabases();
});

/** Use production assembly and committed model profiles without starting a conversation. */
export async function createToolsHostFixture() {
    mockWindows('main');
    const database = openMigratedDatabase();
    routeQueriesTo(database);
    mockTauriCommand('mcp_get_all_client_statuses', []);
    mockTauriCommand('computer_use_list_tools', []);
    mockTauriCommand('agent_skills_discover_system_files', []);
    mockTauriCommand('agent_skills_discover_user_files', []);
    database.exec(`INSERT INTO providers (id, name, driver, api_endpoint, api_key, logo)
        VALUES (1, 'Provider A', 'openai-compatible', 'https://fixture.invalid/v1', 'first-secret', 'openai'),
               (2, 'Provider B', 'openai-compatible', 'https://second.invalid/v1', 'second-secret', 'openai');
        INSERT INTO models (id, provider_id, name, model_id, is_default, tool_call, context_limit)
        VALUES (10, 1, 'Model A', 'model-a', 1, 1, 262144),
               (20, 2, 'Model B', 'model-b', 0, 1, 262144);`);
    const connections = assembleModels();
    const bindings = createTaskModelBindings({ selection: createModelSelection(), connections });
    const preferences = assembleSettingsWindow('main');
    const host = assembleMainTools({
        models: {
            resolve: bindings.resolveTarget,
            isAvailable: bindings.isAvailable,
            complete: bindings.complete,
        },
        settings: {
            read: async (key) => {
                await preferences.api.initialize();
                const value = await preferences.api.readEffectiveValue(key);
                if (
                    typeof value !== 'string' &&
                    typeof value !== 'number' &&
                    typeof value !== 'boolean'
                )
                    throw new Error('SETTING_VALUE_UNAVAILABLE');
                return value;
            },
            mutate: async (key, value) => {
                await preferences.api.initialize();
                return preferences.api.mutate(key, value);
            },
        },
    });
    releases.push(async () => {
        try {
            await host.dispose();
        } finally {
            bindings.dispose();
            preferences.dispose();
            await connections.dispose();
        }
    });
    await host.synchronize();
    const taskId = 'tool-fixture';
    const currentModel = await bindings.start(taskId);
    return { database, host, bindings, taskId, currentModel };
}
