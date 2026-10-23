// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3.

import type { McpServerEntity } from '@database/types';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import McpServerConfig from '@/views/SettingsView/components/McpTools/components/McpServerConfig.vue';

const queriesMock = vi.hoisted(() => ({
    createMcpServer: vi.fn(),
    findAllMcpServers: vi.fn(async () => []),
    updateMcpServer: vi.fn(),
}));

vi.mock('@database/queries', () => ({
    createMcpServer: queriesMock.createMcpServer,
    deleteMcpServer: vi.fn(),
    findAllMcpServers: queriesMock.findAllMcpServers,
    findMcpToolsByServerId: vi.fn(async () => []),
    updateMcpServer: queriesMock.updateMcpServer,
    updateMcpTool: vi.fn(),
}));

vi.mock('@composables/useMcpConnection', () => ({
    useMcpConnection: () => ({
        cleanup: vi.fn(),
        handleConnect: vi.fn(async () => ({ success: true })),
        handleDisconnect: vi.fn(async () => ({ success: true })),
        handleReconnect: vi.fn(async () => ({ success: true })),
        isConnecting: false,
        isDisconnecting: false,
        isReconnecting: false,
        status: 'disconnected',
    }),
}));

vi.mock('@/services/AgentService/infrastructure/mcp', () => ({
    mcpManager: {
        connectServer: vi.fn(),
        disconnectServer: vi.fn(),
        refreshAllServerStatuses: vi.fn(),
        setStatusFromEvent: vi.fn(),
    },
}));

vi.mock('@services/EventService', () => ({
    AppEvent: { MCP_STATUS: 'mcp-status' },
    eventService: { on: vi.fn(async () => undefined) },
}));

vi.mock('@components/AppIcon.vue', () => ({
    default: { name: 'AppIcon', props: ['name'], template: '<span />' },
}));

vi.mock('@components/CustomSelect.vue', () => ({
    default: {
        name: 'CustomSelect',
        props: ['modelValue', 'options'],
        emits: ['update:modelValue'],
        template: `
            <select
                :value="modelValue"
                @change="$emit('update:modelValue', $event.target.value)"
            >
                <option v-for="option in options" :key="option.value" :value="option.value">
                    {{ option.label }}
                </option>
            </select>
        `,
    },
}));

function server(overrides: Partial<McpServerEntity> = {}): McpServerEntity {
    return {
        id: 5,
        name: 'filesystem',
        transport_type: 'stdio',
        command: 'npx',
        args: JSON.stringify(['-y', '@modelcontextprotocol/server-filesystem']),
        env: JSON.stringify({ HOME: '/home/me' }),
        cwd: '/work',
        url: null,
        headers: null,
        enabled: 1,
        tool_timeout: 30_000,
        version: null,
        last_error: null,
        last_connected_at: null,
        created_at: '',
        updated_at: '',
        ...overrides,
    } as McpServerEntity;
}

function newServer(overrides: Partial<McpServerEntity> = {}): McpServerEntity {
    return server({
        id: -1,
        name: '',
        command: '',
        args: null,
        env: null,
        cwd: null,
        tool_timeout: 30_000,
        ...overrides,
    });
}

function mountConfig(value: McpServerEntity) {
    const pinia = createPinia();
    setActivePinia(pinia);
    return mount(McpServerConfig, {
        props: { server: value },
        global: { plugins: [pinia] },
    });
}

function nameField(wrapper: ReturnType<typeof mountConfig>) {
    return wrapper.get('input[type="text"]');
}

/** The command field of a stdio server; its placeholder is translated. */
function commandField(wrapper: ReturnType<typeof mountConfig>): string {
    const field = wrapper
        .findAll('input[type="text"]')
        .find((input) => input.attributes('placeholder') === '例如: npx');
    return (field?.element as HTMLInputElement | undefined)?.value ?? '';
}

function commandInput(wrapper: ReturnType<typeof mountConfig>) {
    return wrapper
        .findAll('input[type="text"]')
        .find((input) => input.attributes('placeholder') === '例如: npx')!;
}

beforeEach(() => {
    vi.clearAllMocks();
    setLocale('zh-CN');
    queriesMock.createMcpServer.mockResolvedValue(1);
    queriesMock.updateMcpServer.mockResolvedValue(undefined);
});

describe('user configures an MCP server', () => {
    it('user sees the saved connection details filled in', () => {
        const wrapper = mountConfig(server());

        expect((nameField(wrapper).element as HTMLInputElement).value).toBe('filesystem');
        expect(commandField(wrapper)).toBe('npx');
        expect((wrapper.get('input[placeholder="30000"]').element as HTMLInputElement).value).toBe(
            '30000'
        );
    });

    it('user saves a rename when leaving the name field', async () => {
        const wrapper = mountConfig(server());

        await nameField(wrapper).setValue('my filesystem');
        await nameField(wrapper).trigger('blur');
        await flushPromises();

        expect(queriesMock.updateMcpServer).toHaveBeenCalledTimes(1);
        expect(queriesMock.updateMcpServer.mock.calls[0]![1]).toMatchObject({
            name: 'my filesystem',
            transport_type: 'stdio',
            command: 'npx',
        });
        expect(wrapper.emitted('updated')).toEqual([[false]]);
    });

    it('user saves the argument list as the server configuration expects', async () => {
        const wrapper = mountConfig(server());

        await nameField(wrapper).trigger('blur');
        await flushPromises();

        const [, payload] = queriesMock.updateMcpServer.mock.calls[0]!;
        expect(JSON.parse(payload.args as string)).toEqual([
            '-y',
            '@modelcontextprotocol/server-filesystem',
        ]);
        expect(JSON.parse(payload.env as string)).toEqual({ HOME: '/home/me' });
    });

    it('user sees an error and nothing is saved when the name is blank', async () => {
        const wrapper = mountConfig(server({ name: '' }));

        await nameField(wrapper).trigger('blur');
        await flushPromises();

        expect(wrapper.emitted('showAlert')).toBeTruthy();
        expect(wrapper.emitted('showAlert')![0]![1]).toBe('error');
        expect(queriesMock.updateMcpServer).not.toHaveBeenCalled();
    });

    it('user sees an error when a command-based server has no command', async () => {
        const wrapper = mountConfig(server({ command: '   ' }));

        await nameField(wrapper).trigger('blur');
        await flushPromises();

        expect(queriesMock.updateMcpServer).not.toHaveBeenCalled();
        expect(wrapper.emitted('showAlert')![0]![1]).toBe('error');
    });

    it('user switches to an HTTP server and is asked for a URL instead of a command', async () => {
        const wrapper = mountConfig(server());

        await wrapper.get('select').setValue('http');
        await flushPromises();

        expect(wrapper.find('input[placeholder="30000"]').exists()).toBe(true);
        expect(wrapper.text()).toContain('URL');
        expect(wrapper.text()).not.toContain('npx');
    });

    it('user sees an error when an HTTP server has no URL', async () => {
        const wrapper = mountConfig(server({ transport_type: 'http', url: '' }));

        await nameField(wrapper).trigger('blur');
        await flushPromises();

        expect(queriesMock.updateMcpServer).not.toHaveBeenCalled();
        expect(wrapper.emitted('showAlert')![0]![1]).toBe('error');
    });

    it('user saves an HTTP server with its URL and headers', async () => {
        const wrapper = mountConfig(
            server({
                transport_type: 'http',
                command: null,
                url: 'https://mcp.example.com/sse',
                headers: JSON.stringify({ Authorization: 'Bearer token' }),
            })
        );

        await nameField(wrapper).trigger('blur');
        await flushPromises();

        const [, payload] = queriesMock.updateMcpServer.mock.calls[0]!;
        expect(payload.url).toBe('https://mcp.example.com/sse');
        expect(JSON.parse(payload.headers as string)).toEqual({ Authorization: 'Bearer token' });
        expect(payload.command).toBeNull();
    });

    it('user is told when the server could not be saved', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        queriesMock.updateMcpServer.mockRejectedValue(new Error('database is locked'));
        const wrapper = mountConfig(server());

        await nameField(wrapper).trigger('blur');
        await flushPromises();

        expect(wrapper.emitted('showAlert')![0]![1]).toBe('error');
        expect(wrapper.emitted('updated')).toBeUndefined();
        consoleError.mockRestore();
    });

    it('user creates a new server as soon as its required fields are filled', async () => {
        vi.useFakeTimers();
        try {
            const wrapper = mountConfig(newServer());

            await nameField(wrapper).setValue('playwright');
            await commandInput(wrapper).setValue('npx');
            await vi.advanceTimersByTimeAsync(900);
            await flushPromises();

            expect(queriesMock.createMcpServer).toHaveBeenCalledTimes(1);
            expect(queriesMock.createMcpServer.mock.calls[0]![0]).toMatchObject({
                name: 'playwright',
                transport_type: 'stdio',
                command: 'npx',
            });
            expect(wrapper.emitted('updated')).toEqual([[true]]);
            wrapper.unmount();
        } finally {
            vi.useRealTimers();
        }
    });

    it('user is not saved repeatedly while still typing a new server', async () => {
        vi.useFakeTimers();
        try {
            const wrapper = mountConfig(newServer());

            await nameField(wrapper).setValue('play');
            await vi.advanceTimersByTimeAsync(400);
            await nameField(wrapper).setValue('playwright');
            await commandInput(wrapper).setValue('npx');
            await vi.advanceTimersByTimeAsync(900);
            await flushPromises();

            expect(queriesMock.createMcpServer).toHaveBeenCalledTimes(1);
            wrapper.unmount();
        } finally {
            vi.useRealTimers();
        }
    });

    it('user sees the English form labels when the app is in English', () => {
        setLocale('en-US');

        const wrapper = mountConfig(server());

        expect(wrapper.text()).toContain('Server configuration');
        expect(wrapper.text()).toContain('Transport type');
    });
});
