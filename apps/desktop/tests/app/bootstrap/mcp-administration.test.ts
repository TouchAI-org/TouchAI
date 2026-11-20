import { mockWindows } from '@tauri-apps/api/mocks';
import { createAgentWindowFixture } from '@tests/utils/agentWindow';
import { afterEach, describe, expect, it } from 'vitest';

import { initializeAgentWindow } from '@/app/bootstrap/agent';

const hosts: ReturnType<typeof initializeAgentWindow>[] = [];
afterEach(async () => {
    await Promise.all(hosts.splice(0).map((host) => host.dispose()));
});

async function configuredMain() {
    const fixture = createAgentWindowFixture();
    hosts.push(fixture.window);
    await fixture.window.ready;
    fixture.database
        .exec(`INSERT INTO mcp_servers (id, name, transport_type, command, env, url, headers)
        VALUES (1, 'Private connection', 'stdio', 'private-command', '{"TOKEN":"private-token"}',
            'https://private.invalid', '{"Authorization":"private-key"}');`);
    return fixture;
}

async function settingsClient() {
    mockWindows('settings');
    const client = initializeAgentWindow();
    hosts.push(client);
    return client;
}

describe('given the production MCP administration boundary', () => {
    it('user given ordinary main when reading the MCP catalog then receives no connection secrets or configuration authority', async () => {
        const { window } = await configuredMain();
        expect(await window.mcp.listServers()).toEqual([
            { id: 1, name: 'Private connection', enabled: 1, version: null },
        ]);
        expect(window.mcpAdministration).toBeUndefined();
        expect(Object.keys(window.mcp)).not.toContain('findAllMcpServers');
    });

    it('user given settings when reading and editing configuration then preserves saved JSON bytes through main', async () => {
        const fixture = await configuredMain();
        const client = await settingsClient();
        expect((await client.mcpAdministration!.findAllMcpServers())[0]).toMatchObject({
            command: 'private-command',
            env: '{"TOKEN":"private-token"}',
        });
        const env = '{ "NEXT_TOKEN" : "saved-value" }';
        await client.mcpAdministration!.updateMcpServer(1, { env, enabled: 0 });
        expect(
            fixture.database.prepare('SELECT env, enabled FROM mcp_servers WHERE id = 1').get()
        ).toEqual({ env, enabled: 0 });
        expect(await fixture.window.mcp.listServers()).toEqual([
            { id: 1, name: 'Private connection', enabled: 0, version: null },
        ]);
    });

    it('user given a failed write when settings retries explicitly then sees a safe failure and a later saved result', async () => {
        const fixture = await configuredMain();
        const client = await settingsClient();
        fixture.database.exec(`CREATE TEMP TRIGGER reject_mcp_write BEFORE UPDATE ON mcp_servers
            BEGIN SELECT RAISE(ABORT, 'private SQL secret'); END;`);
        await expect(
            client.mcpAdministration!.updateMcpServer(1, { name: 'Changed' })
        ).rejects.toMatchObject({ code: 'MCP_COMMAND_FAILED', message: 'MCP_COMMAND_FAILED' });
        expect(fixture.database.prepare('SELECT name FROM mcp_servers WHERE id = 1').get()).toEqual(
            { name: 'Private connection' }
        );
        fixture.database.exec('DROP TRIGGER reject_mcp_write');
        await client.mcpAdministration!.updateMcpServer(1, { name: 'Changed' });
        expect((await client.mcpAdministration!.findAllMcpServers())[0]?.name).toBe('Changed');
    });

    it('user given a detached settings client when saving another draft then starts no database effect', async () => {
        const fixture = await configuredMain();
        const client = await settingsClient();
        await client.dispose();
        await expect(
            client.mcpAdministration!.updateMcpServer(1, { name: 'Detached' })
        ).rejects.toMatchObject({ code: 'MCP_COMMAND_UNAVAILABLE' });
        expect(fixture.database.prepare('SELECT name FROM mcp_servers WHERE id = 1').get()).toEqual(
            { name: 'Private connection' }
        );
    });

    it('user given a cast configuration payload when attempting to write internal row identity then is refused without changing storage', async () => {
        const fixture = await configuredMain();
        const client = await settingsClient();
        await expect(
            client.mcpAdministration!.updateMcpServer(1, { id: 100 } as never)
        ).rejects.toMatchObject({ code: 'MCP_COMMAND_UNAVAILABLE' });
        expect(fixture.database.prepare('SELECT id FROM mcp_servers').all()).toEqual([{ id: 1 }]);
    });
});
