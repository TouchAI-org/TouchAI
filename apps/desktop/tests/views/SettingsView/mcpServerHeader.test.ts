import type { McpServerEntity } from '@database/types';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

import { setLocale } from '@/i18n';
import McpServerHeader from '@/views/SettingsView/components/McpTools/components/McpServerHeader.vue';

/*
 * The header is the only place a user can start or stop an MCP server, so what
 * matters is which action it offers for each connection state and what it tells
 * the user afterwards. The connection layer is mocked only because it owns the
 * transport; every assertion below is about the DOM the user sees or the alert
 * the parent receives.
 */

// Captured so a test can prove the header hands the connection layer a live ref
// of the server id, which is what keeps it following the selected server.
const passedServerId = vi.hoisted(() => ({ value: null as unknown }));

const connection = vi.hoisted(() => ({
    status: { value: 'disconnected' },
    isConnecting: { value: false },
    isDisconnecting: { value: false },
    isReconnecting: { value: false },
    handleConnect: vi.fn(async () => ({ success: true })),
    handleDisconnect: vi.fn(async () => ({ success: true })),
    handleReconnect: vi.fn(async () => ({ success: true })),
    cleanup: vi.fn(),
}));

const serverError = vi.hoisted(() => ({ value: null as string | null }));

vi.mock('@composables/useMcpConnection', () => ({
    useMcpConnection: (serverId: unknown) => {
        passedServerId.value = serverId;
        return {
            status: connection.status,
            isConnecting: connection.isConnecting,
            isDisconnecting: connection.isDisconnecting,
            isReconnecting: connection.isReconnecting,
            handleConnect: connection.handleConnect,
            handleDisconnect: connection.handleDisconnect,
            handleReconnect: connection.handleReconnect,
            cleanup: connection.cleanup,
        };
    },
}));

vi.mock('@/stores/mcp', () => ({
    useMcpStore: () => ({
        getServerError: () => serverError.value,
    }),
}));

vi.mock('@components/AppIcon.vue', () => ({
    default: {
        name: 'AppIcon',
        props: ['name'],
        template: '<span data-testid="app-icon" :data-name="name" />',
    },
}));

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
    return mount(McpServerHeader, {
        props: { server, isNewServer: false, ...props },
    });
}

function alertCalls(wrapper: ReturnType<typeof mountHeader>) {
    return wrapper.emitted('showAlert') ?? [];
}

function setStatus(value: string) {
    connection.status = ref(value) as unknown as typeof connection.status;
}

beforeEach(() => {
    setLocale('zh-CN');
    connection.status = ref('disconnected') as unknown as typeof connection.status;
    connection.isConnecting = ref(false) as unknown as typeof connection.isConnecting;
    connection.isDisconnecting = ref(false) as unknown as typeof connection.isDisconnecting;
    connection.isReconnecting = ref(false) as unknown as typeof connection.isReconnecting;
    connection.handleConnect.mockReset();
    connection.handleDisconnect.mockReset();
    connection.handleReconnect.mockReset();
    connection.handleConnect.mockResolvedValue({ success: true });
    connection.handleDisconnect.mockResolvedValue({ success: true });
    connection.handleReconnect.mockResolvedValue({ success: true });
    connection.cleanup.mockReset();
    serverError.value = null;
});

describe('user reads the connection state of a server', () => {
    it('user sees a disconnected server named and labelled', () => {
        const wrapper = mountHeader();

        expect(wrapper.text()).toContain('filesystem');
        expect(wrapper.text()).toContain('stdio');
        expect(wrapper.text()).toContain('2026.05.22');
        expect(wrapper.text()).toContain('未连接');
    });

    it('user sees a connected server said to be connected', () => {
        setStatus('connected');

        const wrapper = mountHeader();

        expect(wrapper.text()).toContain('已连接');
    });

    it('user sees a connecting server said to be connecting', () => {
        setStatus('connecting');

        const wrapper = mountHeader();

        expect(wrapper.text()).toContain('连接中');
    });

    it('user sees a broken server reported as a connection error', () => {
        setStatus('error');

        const wrapper = mountHeader();

        expect(wrapper.text()).toContain('连接错误');
    });

    it('user sees the last error text when a connect attempt failed', () => {
        setStatus('error');
        serverError.value = 'spawn npx ENOENT';

        const wrapper = mountHeader();

        expect(wrapper.text()).toContain('spawn npx ENOENT');
    });

    it('user does not see an error block for a stored error while the server is connected', () => {
        setStatus('connected');
        serverError.value = 'a stale failure';

        const wrapper = mountHeader();

        expect(wrapper.text()).not.toContain('a stale failure');
    });

    it('user sees no version badge when the server reported no version', () => {
        const wrapper = mountHeader({ server: { ...server, version: null } });

        expect(wrapper.text()).toContain('filesystem');
        expect(wrapper.text()).not.toContain('2026.05.22');
    });
});

describe('user adds a server that does not exist yet', () => {
    it('user sees only a title while the server is unsaved', () => {
        const wrapper = mountHeader({ isNewServer: true });

        expect(wrapper.text()).toContain('新建服务器');
        expect(wrapper.text()).not.toContain('filesystem');
    });

    it('user gets no transport badge for an unsaved server', () => {
        const wrapper = mountHeader({ isNewServer: true });

        expect(wrapper.text()).not.toContain('stdio');
    });

    it('user gets no connect or disconnect action before the server is saved', () => {
        const wrapper = mountHeader({ isNewServer: true });

        expect(wrapper.findAll('button')).toHaveLength(0);
    });
});

describe('user starts a stopped server', () => {
    it('user gets a confirmation naming the server once it connects', async () => {
        const wrapper = mountHeader();

        await wrapper.get('button').trigger('click');
        await flushPromises();

        expect(connection.handleConnect).toHaveBeenCalledOnce();
        expect(alertCalls(wrapper)[0]).toEqual(['服务器 "filesystem" 连接成功', 'success']);
    });

    it('user gets the failure reason when the server refuses to start', async () => {
        connection.handleConnect.mockResolvedValue({
            success: false,
            error: 'no such command',
        } as never);
        const wrapper = mountHeader();

        await wrapper.get('button').trigger('click');
        await flushPromises();

        expect(alertCalls(wrapper)[0]).toEqual(['连接失败: no such command', 'error']);
    });

    it('user gets no alert when the connect was already in flight', async () => {
        connection.handleConnect.mockResolvedValue({ success: false });
        const wrapper = mountHeader();

        await wrapper.get('button').trigger('click');
        await flushPromises();

        expect(alertCalls(wrapper)).toHaveLength(0);
    });

    it('user sees the button become busy while the connection opens', async () => {
        connection.isConnecting = ref(true) as unknown as typeof connection.isConnecting;
        const wrapper = mountHeader();

        const button = wrapper.get('button');
        expect(button.text()).toContain('连接中...');
        expect(button.attributes('disabled')).toBeDefined();
    });
});

describe('user stops a running server', () => {
    it('user gets a confirmation naming the server once it stops', async () => {
        setStatus('connected');
        const wrapper = mountHeader();

        await wrapper.get('button').trigger('click');
        await flushPromises();

        expect(connection.handleDisconnect).toHaveBeenCalledOnce();
        expect(alertCalls(wrapper)[0]).toEqual(['服务器 "filesystem" 已断开', 'success']);
    });

    it('user gets the failure reason when the server will not stop', async () => {
        setStatus('connected');
        connection.handleDisconnect.mockResolvedValue({
            success: false,
            error: 'timed out',
        } as never);
        const wrapper = mountHeader();

        await wrapper.get('button').trigger('click');
        await flushPromises();

        expect(alertCalls(wrapper)[0]).toEqual(['断开失败: timed out', 'error']);
    });

    it('user gets no alert when the disconnect was already in flight', async () => {
        setStatus('connected');
        connection.handleDisconnect.mockResolvedValue({ success: false });
        const wrapper = mountHeader();

        await wrapper.get('button').trigger('click');
        await flushPromises();

        expect(alertCalls(wrapper)).toHaveLength(0);
    });

    it('user sees the button become busy while the server shuts down', () => {
        setStatus('connected');
        connection.isDisconnecting = ref(true) as unknown as typeof connection.isDisconnecting;
        const wrapper = mountHeader();

        const button = wrapper.get('button');
        expect(button.text()).toContain('断开中...');
        expect(button.attributes('disabled')).toBeDefined();
    });
});

describe('user reconnects a running server', () => {
    it('user gets a confirmation naming the server once it reconnects', async () => {
        setStatus('connected');
        const wrapper = mountHeader();

        await wrapper.findAll('button')[1]!.trigger('click');
        await flushPromises();

        expect(connection.handleReconnect).toHaveBeenCalledOnce();
        expect(alertCalls(wrapper)[0]).toEqual(['服务器 "filesystem" 重新连接成功', 'success']);
    });

    it('user gets the failure reason when the reconnect fails', async () => {
        setStatus('connected');
        connection.handleReconnect.mockResolvedValue({
            success: false,
            error: 'handshake failed',
        } as never);
        const wrapper = mountHeader();

        await wrapper.findAll('button')[1]!.trigger('click');
        await flushPromises();

        expect(alertCalls(wrapper)[0]).toEqual(['重新连接失败: handshake failed', 'error']);
    });

    it('user gets no alert when the reconnect was already in flight', async () => {
        setStatus('connected');
        connection.handleReconnect.mockResolvedValue({ success: false });
        const wrapper = mountHeader();

        await wrapper.findAll('button')[1]!.trigger('click');
        await flushPromises();

        expect(alertCalls(wrapper)).toHaveLength(0);
    });

    it('user sees the reconnect action become busy while it runs', () => {
        setStatus('connected');
        connection.isReconnecting = ref(true) as unknown as typeof connection.isReconnecting;
        const wrapper = mountHeader();

        expect(wrapper.findAll('button')[1]!.text()).toContain('重新连接中...');
    });

    it('user gets the reconnect action blocked while the server is stopping', () => {
        setStatus('connected');
        connection.isDisconnecting = ref(true) as unknown as typeof connection.isDisconnecting;
        const wrapper = mountHeader();

        expect(wrapper.findAll('button')[1]!.attributes('disabled')).toBeDefined();
    });
});

describe('user waits for a server that is already coming up', () => {
    it('user sees a disabled notice instead of a start action', () => {
        setStatus('connecting');
        const wrapper = mountHeader();

        const buttons = wrapper.findAll('button');
        expect(buttons).toHaveLength(1);
        expect(buttons[0]!.text()).toContain('连接中...');
        expect(buttons[0]!.attributes('disabled')).toBeDefined();
    });

    it('user gets no reconnect action while the server is still connecting', () => {
        setStatus('connecting');
        const wrapper = mountHeader();

        expect(wrapper.text()).not.toContain('重新连接');
    });
});

describe('user switches to another server in the panel', () => {
    it('user gets the connection layer pointed at the server currently on screen', () => {
        const wrapper = mountHeader();

        const serverId = passedServerId.value as { value: number };
        expect(serverId.value).toBe(7);
        wrapper.unmount();
    });

    it('user gets the connection layer following the panel to the next server', async () => {
        const wrapper = mountHeader();

        await wrapper.setProps({ server: { ...server, id: 12, name: 'github' } });

        const serverId = passedServerId.value as { value: number };
        expect(serverId.value).toBe(12);
        wrapper.unmount();
    });
});

describe('user leaves the panel', () => {
    it('user gets the connection listener released on unmount', () => {
        const wrapper = mountHeader();

        wrapper.unmount();

        expect(connection.cleanup).toHaveBeenCalledOnce();
    });
});
