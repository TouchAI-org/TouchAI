import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '@tests/database/sqliteHarness';
import { afterEach } from 'vitest';

import { createPersistedAttachmentFromData } from '@/modules/attachments';
import { createMcpConnections, createTools } from '@/modules/tools';
import { log } from '@/platform/diagnostics';

import { mockTauriCommand } from './tauri';
import { toolMessages } from './toolMessages';

const owners: { dispose(): Promise<void> }[] = [];
afterEach(async () => {
    for (const owner of owners.splice(0)) await owner.dispose().catch(() => undefined);
    closeTestDatabases();
});

export function createMcpHostFixture(
    input: { timeout?: number; enabled?: number; query?: Parameters<typeof routeQueriesTo>[1] } = {}
) {
    const database = openMigratedDatabase();
    routeQueriesTo(database, input.query);
    database
        .prepare(
            `INSERT INTO mcp_servers (id, name, transport_type, command, args, env, enabled, tool_timeout)
        VALUES (1, 'filesystem', 'stdio', 'node', '["--verbose"]', '{"MODE":"fixture"}', ?, ?)`
        )
        .run(input.enabled ?? 1, input.timeout ?? 30000);
    mockTauriCommand('mcp_get_client_status', { server_id: 1, status: 'connected', version: null });
    mockTauriCommand('mcp_get_all_client_statuses', []);
    mockTauriCommand('mcp_list_tools', [
        {
            name: 'read_file',
            description: 'Read a file',
            input_schema: { type: 'object', properties: { path: { type: 'string' } } },
        },
    ]);
    mockTauriCommand('mcp_call_tool', {
        success: true,
        is_error: false,
        content: [{ type: 'text', text: 'ok' }],
    });
    const connections = createMcpConnections({
        messages: toolMessages,
        diagnostics: log,
        resources: { create: createPersistedAttachmentFromData },
    });
    const tools = createTools({
        registrations: [],
        mcp: connections,
        formatError: (code, details) => details ?? code,
    });
    owners.push({
        async dispose() {
            tools.dispose();
            await connections.dispose();
        },
    });
    return { database, connections, tools };
}
