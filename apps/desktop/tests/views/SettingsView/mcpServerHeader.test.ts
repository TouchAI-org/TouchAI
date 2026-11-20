import { emit } from '@tauri-apps/api/event';
import { createSettingsPanelFixture } from '@tests/utils/settingsPanel';
import { getTauriInvokeCalls, mockTauriCommand } from '@tests/utils/tauri';
import { createTestWindowPresentation } from '@tests/utils/windowPresentation';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach as beforePresentation } from 'vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppEvent } from '@/app/api/tools/events';
import type { McpServerEntity } from '@/app/api/tools/mcpAdministration';
import { setLocale, t } from '@/i18n';
import { useMcpStore } from '@/stores/mcp';
import McpServerHeader from '@/views/SettingsView/components/McpTools/components/McpServerHeader.vue';

let fixture: Awaited<ReturnType<typeof createSettingsPanelFixture>>;
const wrappers: ReturnType<typeof mount>[] = [];
const releases: (() => void)[] = [];
afterEach(async () => {
    releases.splice(0).forEach((release) => release());
    await flushPromises();
    wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
    await fixture?.dispose();
});
function deferCommand(command: string) {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
        release = resolve;
    });
    releases.push(release);
    mockTauriCommand(command, () => promise);
    return release;
}
const server: McpServerEntity = {
    args: null,
    command: 'npx',
    created_at: '2026-05-20T00:00:00.000Z',
    cwd: null,
    enabled: 1,
    env: null,
    headers: null,
    id: 7,
    last_connected_at: null,
    last_error: null,
    name: 'filesystem',
    tool_timeout: 30000,
    transport_type: 'stdio' as McpServerEntity['transport_type'],
    updated_at: '2026-05-20T00:00:00.000Z',
    url: null,
    version: '2026.05.22',
};

function mountHeader(props: Record<string, unknown> = {}) {
    const wrapper = mount(McpServerHeader, {
        props: { server, isNewServer: false, ...props },
        ...fixture.viewOptions,
    });
    wrappers.push(wrapper);
    return wrapper;
}
function alerts(wrapper: ReturnType<typeof mountHeader>) {
    return wrapper.emitted('showAlert') ?? [];
}
async function setStatus(
    status: 'connected' | 'disconnected' | 'connecting' | 'error',
    error?: string
) {
    await emit(AppEvent.MCP_STATUS, { serverId: server.id, status, ...(error ? { error } : {}) });
    await flushPromises();
}
beforeEach(async () => {
    fixture = await createSettingsPanelFixture();
    const keys = Object.keys(server);
    for (const value of [server, { ...server, id: 12, name: 'github' }]) {
        fixture.database
            .prepare(
                `INSERT INTO mcp_servers (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`
            )
            .run(...Object.values(value));
    }
    mockTauriCommand('mcp_connect_server', null);
    mockTauriCommand('mcp_disconnect_server', null);
    mockTauriCommand('mcp_list_tools', []);
    mockTauriCommand('mcp_get_client_status', (payload) => ({
        server_id: (payload as { serverId: number }).serverId,
        status: 'connected',
        version: '2026.05.22',
    }));
    await fixture.runWithContext(() => useMcpStore(fixture.pinia)).initialize();
    setLocale('zh-CN');
});

describe('given a saved MCP connection through production main and settings', () => {
    it('user sees a disconnected server named and labelled', () => {
        const wrapper = mountHeader();
        expect(wrapper.text()).toContain('filesystem');
        expect(wrapper.text()).toContain('stdio');
        expect(wrapper.text()).toContain('2026.05.22');
        expect(wrapper.text()).toContain(t('settings.mcp.status.disconnected'));
    });
    it.each([
        ['connected', 'settings.mcp.status.connected'],
        ['connecting', 'settings.mcp.status.connecting'],
        ['error', 'settings.mcp.status.connectionError'],
    ] as const)(
        'user sees the current %s state when the native status arrives',
        async (status, key) => {
            const wrapper = mountHeader();
            await setStatus(status);
            expect(wrapper.text()).toContain(t(key));
        }
    );
    it('user sees the last error text when a connection fails', async () => {
        const wrapper = mountHeader();
        await setStatus('error', 'spawn npx ENOENT');
        expect(wrapper.text()).toContain('spawn npx ENOENT');
    });
    it('user sees no stale error block while connected', async () => {
        const wrapper = mountHeader();
        await setStatus('connected', 'a stale failure');
        expect(wrapper.text()).not.toContain('a stale failure');
    });
    it('user sees no version badge when the server reported none', () => {
        expect(mountHeader({ server: { ...server, version: null } }).text()).not.toContain(
            '2026.05.22'
        );
    });
});

describe('given an unsaved server', () => {
    it('user sees its title without the saved server name', () => {
        const wrapper = mountHeader({ isNewServer: true });
        expect(wrapper.text()).toContain(t('settings.mcp.servers.new'));
        expect(wrapper.text()).not.toContain('filesystem');
    });
    it('user sees no transport badge before saving', () => {
        expect(mountHeader({ isNewServer: true }).text()).not.toContain('stdio');
    });
    it('user cannot connect or disconnect before saving', () => {
        expect(mountHeader({ isNewServer: true }).findAll('button')).toHaveLength(0);
    });
});

describe('given an available connection action', () => {
    it.each([
        [
            'connect',
            'disconnected',
            'mcp_connect_server',
            0,
            'settings.mcp.messages.serverConnectSuccess',
        ],
        [
            'disconnect',
            'connected',
            'mcp_disconnect_server',
            0,
            'settings.mcp.messages.serverDisconnectSuccess',
        ],
        [
            'reconnect',
            'connected',
            'mcp_disconnect_server',
            1,
            'settings.mcp.messages.serverReconnectSuccess',
        ],
    ] as const)(
        'user receives one confirmation when %s completes through main',
        async (_action, status, _command, index, key) => {
            await setStatus(status);
            const wrapper = mountHeader();
            await wrapper.findAll('button')[index]!.trigger('click');
            await flushPromises();
            expect(alerts(wrapper)).toEqual([[t(key, { serverName: 'filesystem' }), 'success']]);
        }
    );
    it.each([
        ['connect', 'disconnected', 'mcp_connect_server', 0],
        ['disconnect', 'connected', 'mcp_disconnect_server', 0],
        ['reconnect', 'connected', 'mcp_disconnect_server', 1],
    ] as const)(
        'user receives a safe failure when %s is rejected by native',
        async (_action, status, command, index) => {
            await setStatus(status);
            mockTauriCommand(command, () => {
                throw new Error('private native path');
            });
            const wrapper = mountHeader();
            await wrapper.findAll('button')[index]!.trigger('click');
            await flushPromises();
            expect(alerts(wrapper)).toHaveLength(1);
            expect(alerts(wrapper)[0]?.[1]).toBe('error');
            expect(JSON.stringify(alerts(wrapper))).not.toContain('private native path');
        }
    );
    it.each([
        ['connect', 'disconnected', 'mcp_connect_server', 0, 'settings.mcp.actions.connecting'],
        [
            'disconnect',
            'connected',
            'mcp_disconnect_server',
            0,
            'settings.mcp.actions.disconnecting',
        ],
        ['reconnect', 'connected', 'mcp_disconnect_server', 1, 'settings.mcp.actions.reconnecting'],
    ] as const)(
        'user sees a busy %s action until its native acknowledgement arrives',
        async (_action, status, command, index, key) => {
            await setStatus(status);
            const release = deferCommand(command);
            const wrapper = mountHeader();
            await wrapper.findAll('button')[index]!.trigger('click');
            await flushPromises();
            expect(wrapper.findAll('button')[index]!.text()).toContain(t(key));
            expect(wrapper.findAll('button')[index]!.attributes('disabled')).toBeDefined();
            expect(alerts(wrapper)).toHaveLength(0);
            release();
            await flushPromises();
            expect(alerts(wrapper)).toHaveLength(1);
        }
    );
    it.each([
        ['connect', 'disconnected', 'mcp_connect_server', 0],
        ['disconnect', 'connected', 'mcp_disconnect_server', 0],
        ['reconnect', 'connected', 'mcp_disconnect_server', 1],
    ] as const)(
        'user receives no duplicate confirmation when %s is clicked again while busy',
        async (_action, status, command, index) => {
            await setStatus(status);
            const release = deferCommand(command);
            const wrapper = mountHeader();
            await wrapper.findAll('button')[index]!.trigger('click');
            await flushPromises();
            await wrapper.findAll('button')[index]!.trigger('click');
            expect(alerts(wrapper)).toHaveLength(0);
            release();
            await flushPromises();
            expect(alerts(wrapper)).toHaveLength(1);
        }
    );
    it('user cannot reconnect while disconnect is in flight', async () => {
        await setStatus('connected');
        deferCommand('mcp_disconnect_server');
        const wrapper = mountHeader();
        await wrapper.findAll('button')[0]!.trigger('click');
        await flushPromises();
        expect(wrapper.findAll('button')[1]!.attributes('disabled')).toBeDefined();
    });
});

describe('given a server already connecting', () => {
    it('user sees a disabled connecting notice', async () => {
        await setStatus('connecting');
        const buttons = mountHeader().findAll('button');
        expect(buttons).toHaveLength(1);
        expect(buttons[0]!.text()).toContain(t('settings.mcp.actions.connecting'));
        expect(buttons[0]!.attributes('disabled')).toBeDefined();
    });
    it('user sees no reconnect action until connected', async () => {
        await setStatus('connecting');
        expect(mountHeader().text()).not.toContain(t('settings.mcp.actions.reconnect'));
    });
});

describe('given a settings panel selection and lifetime', () => {
    it('user connects the currently visible server', async () => {
        const wrapper = mountHeader();
        await wrapper.get('button').trigger('click');
        await flushPromises();
        expect(getTauriInvokeCalls('mcp_connect_server').at(-1)?.payload).toMatchObject({
            config: { id: 7 },
        });
    });
    it('user connects the next server after changing selection', async () => {
        const wrapper = mountHeader();
        await wrapper.setProps({ server: { ...server, id: 12, name: 'github' } });
        await wrapper.get('button').trigger('click');
        await flushPromises();
        expect(getTauriInvokeCalls('mcp_connect_server').at(-1)?.payload).toMatchObject({
            config: { id: 12 },
        });
        expect(alerts(wrapper)[0]).toEqual([
            t('settings.mcp.messages.serverConnectSuccess', { serverName: 'github' }),
            'success',
        ]);
    });
    it('user receives no late success after leaving a panel with a pending native connection', async () => {
        const release = deferCommand('mcp_connect_server');
        const wrapper = mountHeader();
        await wrapper.get('button').trigger('click');
        await flushPromises();
        wrapper.unmount();
        release();
        await flushPromises();
        expect(alerts(wrapper)).toHaveLength(0);
    });
});

beforePresentation(async () => {
    (await createTestWindowPresentation('settings')).install();
});
