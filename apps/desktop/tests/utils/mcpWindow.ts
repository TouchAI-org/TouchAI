import { mockWindows } from '@tauri-apps/api/mocks';
import { flushPromises } from '@vue/test-utils';
import { createPinia, disposePinia } from 'pinia';

import { mcpApiKey } from '@/app/api/tools/mcp';
import { initializeAgentWindow } from '@/app/bootstrap/agent';
import { useMcpStore } from '@/stores/mcp';

import { openMigratedDatabase, routeQueriesTo } from '../database/sqliteHarness';
import { mountComposable } from './composables';
import { mockTauriCommand } from './tauri';

/** The UI receives the same window API that production bootstrap provides. */
export async function mountMcpWindow<T>(
    factory: () => T,
    options: { label?: 'main' | 'settings'; query?: Parameters<typeof routeQueriesTo>[1] } = {}
) {
    mockWindows('main');
    const database = openMigratedDatabase();
    routeQueriesTo(database, options.query);
    database.exec(`INSERT INTO mcp_servers (id, name, transport_type, command)
        VALUES (1, 'Local MCP', 'stdio', 'fixture'), (2, 'Other MCP', 'stdio', 'fixture');`);
    mockTauriCommand('mcp_get_all_client_statuses', []);
    mockTauriCommand('mcp_get_client_status', { server_id: 1, status: 'connected' });
    mockTauriCommand('mcp_list_tools', []);
    mockTauriCommand('computer_use_list_tools', []);
    mockTauriCommand('agent_skills_discover_system_files', []);
    mockTauriCommand('agent_skills_discover_user_files', []);
    const main = initializeAgentWindow();
    await main.ready;
    await main.capabilities.waitForAgent();
    const label = options.label ?? 'settings';
    mockWindows(label);
    const client = label === 'main' ? main : initializeAgentWindow();
    const pinia = createPinia();
    const mounted = await mountComposable(
        () => ({ store: useMcpStore(), value: factory() }),
        (app) => {
            app.use(pinia);
            app.provide(mcpApiKey, client.mcp);
        }
    );
    return {
        ...mounted.result,
        database,
        async dispose() {
            mounted.unmount();
            disposePinia(pinia);
            await flushPromises();
            if (client !== main) await client.dispose();
            await main.dispose();
        },
    };
}
