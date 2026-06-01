import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import { createDomLocalizer } from '@/i18n/domLocalizer';
import McpServerConfig from '@/views/SettingsView/components/McpTools/components/McpServerConfig.vue';
import McpToolList from '@/views/SettingsView/components/McpTools/components/McpToolList.vue';
import McpToolLogViewer from '@/views/SettingsView/components/McpTools/components/McpToolLogViewer.vue';
import McpToolsSection from '@/views/SettingsView/components/McpTools/index.vue';

const { findMcpToolLogsByServerIdMock, findMcpToolsByServerIdMock } = vi.hoisted(() => ({
    findMcpToolLogsByServerIdMock: vi.fn(),
    findMcpToolsByServerIdMock: vi.fn(),
}));

vi.mock('@database/queries', () => ({
    createMcpServer: vi.fn(),
    deleteMcpServer: vi.fn(),
    findAllMcpServers: vi.fn(async () => []),
    findMcpToolLogsByServerId: findMcpToolLogsByServerIdMock,
    findMcpToolsByServerId: findMcpToolsByServerIdMock,
    updateMcpServer: vi.fn(),
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

vi.mock('@composables/useScrollbarStabilizer', () => ({
    useScrollbarStabilizer: vi.fn(),
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

vi.mock('@/utils/mcpSchemas', () => ({
    parseMcpServerArgsJson: (value: string | null) => (value ? JSON.parse(value) : []),
    parseMcpServerRecordJson: (value: string | null) => (value ? JSON.parse(value) : {}),
    parseMcpToolSchemaJson: (value?: string | null) =>
        value ? JSON.parse(value) : { properties: {}, required: [], type: 'object' },
    toKeyValueEntries: (record: Record<string, string>) =>
        Object.entries(record).map(([key, value]) => ({ key, value })),
}));

vi.mock('@components/AlertMessage.vue', () => ({
    default: {
        name: 'AlertMessage',
        template: '<div data-testid="alert-message" />',
        methods: {
            error: vi.fn(),
            success: vi.fn(),
        },
    },
}));

vi.mock('@components/AppIcon.vue', () => ({
    default: {
        name: 'AppIcon',
        props: ['name'],
        template: '<span data-testid="app-icon" />',
    },
}));

vi.mock('@components/CustomSelect.vue', () => ({
    default: {
        name: 'CustomSelect',
        props: ['modelValue', 'options'],
        emits: ['update:modelValue'],
        template:
            '<div data-testid="custom-select"><div v-for="option in options" :key="option.value">{{ option.label }} {{ option.description }}</div></div>',
    },
}));

vi.mock('@components/ToolLogContent.vue', () => ({
    default: {
        name: 'ToolLogContent',
        props: ['input', 'output', 'error'],
        template: '<div data-testid="tool-log-content">{{ input }}{{ output }}{{ error }}</div>',
    },
}));

const server = {
    args: null,
    command: 'npx',
    created_at: '2026-05-20T00:00:00.000Z',
    cwd: null,
    enabled: 1,
    env: null,
    headers: null,
    id: 1,
    last_connected_at: null,
    last_error: null,
    name: 'very-long-mcp-server-name-without-natural-breaks',
    tool_timeout: 30000,
    transport_type: 'stdio',
    updated_at: '2026-05-20T00:00:00.000Z',
    url: null,
    version: '2026.05.22',
} as const;

function mountWithPinia(component: Parameters<typeof mount>[0], options = {}) {
    const pinia = createPinia();
    setActivePinia(pinia);

    return mount(component, {
        global: {
            plugins: [pinia],
        },
        ...options,
    });
}

async function flushMountedPromises() {
    for (let index = 0; index < 4; index += 1) {
        await Promise.resolve();
    }
}

describe('MCP settings i18n and long text layout', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setLocale('en-US');
        document.documentElement.lang = 'en-US';
        findMcpToolsByServerIdMock.mockResolvedValue([]);
    });

    it('renders section tabs, buttons, and empty states in English', async () => {
        const wrapper = mountWithPinia(McpToolsSection);

        await flushMountedPromises();

        expect(wrapper.text()).toContain('+ Add MCP server');
        expect(wrapper.text()).toContain('No servers yet');
        expect(wrapper.text()).toContain('Click the button below to add a server');
        expect(wrapper.text()).not.toContain('暂无服务器');
    });

    it('renders configuration labels, placeholders, and transport descriptions in English', () => {
        const wrapper = mountWithPinia(McpServerConfig, {
            props: { server },
        });

        expect(wrapper.text()).toContain('Server configuration');
        expect(wrapper.text()).toContain('very-long-mcp-server-name-without-natural-breaks');
        expect(wrapper.text()).toContain('Name');
        expect(wrapper.text()).toContain('Transport type');
        expect(wrapper.text()).toContain('Standard input/output');
        expect(wrapper.text()).toContain('Compatible with Streamable HTTP and SSE');
        expect(wrapper.text()).toContain('Tool timeout (ms)');
        expect(wrapper.find('input[placeholder="Server name"]').exists()).toBe(true);
        expect(wrapper.find('input[placeholder="Example: npx"]').exists()).toBe(true);
        expect(wrapper.find('input[placeholder="Example: /path/to/directory"]').exists()).toBe(
            true
        );
        expect(wrapper.text()).not.toContain('服务器配置');
    });

    it('renders tool filters, empty states, parameter labels, and wrapping classes in English', async () => {
        findMcpToolsByServerIdMock.mockResolvedValue([
            {
                created_at: '2026-05-20T00:00:00.000Z',
                description:
                    'long-description-without-natural-breaks-long-description-without-natural-breaks',
                enabled: 1,
                id: 10,
                input_schema: JSON.stringify({
                    properties: {
                        'very-long-parameter-name-without-natural-breaks': {
                            description: 'very-long-parameter-description-without-natural-breaks',
                            type: 'string',
                        },
                    },
                    required: ['very-long-parameter-name-without-natural-breaks'],
                    type: 'object',
                }),
                name: 'very-long-tool-name-without-natural-breaks',
                server_id: server.id,
                updated_at: '2026-05-20T00:00:00.000Z',
            },
        ]);
        const wrapper = mountWithPinia(McpToolList, {
            props: { server },
        });

        await flushMountedPromises();
        await wrapper.get('button.w-full').trigger('click');

        expect(wrapper.text()).toContain('All');
        expect(wrapper.text()).toContain('Enabled');
        expect(wrapper.text()).toContain('Disabled');
        expect(wrapper.find('input[placeholder="Search tools..."]').exists()).toBe(true);
        expect(wrapper.text()).toContain('Input');
        expect(wrapper.text()).toContain('Parameter name');
        expect(wrapper.text()).toContain('Required');
        expect(wrapper.text()).toContain('Yes');
        expect(wrapper.find('table').classes()).toContain('min-w-full');
        expect(wrapper.find('td').classes()).toContain('break-all');
    });

    it('does not let the global DOM localizer rewrite dynamic MCP tool payload text', async () => {
        findMcpToolsByServerIdMock.mockResolvedValue([
            {
                created_at: '2026-05-20T00:00:00.000Z',
                description: '描述',
                enabled: 1,
                id: 10,
                input_schema: JSON.stringify({
                    properties: {
                        参数: {
                            description: '工具',
                            type: 'string',
                        },
                    },
                    required: ['参数'],
                    type: 'object',
                }),
                name: '工具',
                server_id: server.id,
                updated_at: '2026-05-20T00:00:00.000Z',
            },
        ]);
        const wrapper = mountWithPinia(McpToolList, {
            props: { server },
            attachTo: document.body,
        });

        await flushMountedPromises();
        await wrapper.get('button.w-full').trigger('click');

        const localizer = createDomLocalizer(document.body);
        localizer.translateNow();

        expect(wrapper.text()).toContain('All');
        expect(wrapper.text()).toContain('Input');
        expect(wrapper.get('h3').text()).toBe('工具');
        expect(wrapper.get('h3').attributes('data-no-i18n')).toBe('true');
        expect(wrapper.get('p[data-no-i18n="true"]').text()).toBe('描述');
        expect(wrapper.findAll('td')[0]?.text()).toBe('参数');
        expect(wrapper.findAll('td')[0]?.attributes('data-no-i18n')).toBe('true');
        expect(wrapper.findAll('td')[1]?.text()).toBe('string');
        expect(wrapper.findAll('td')[1]?.attributes('data-no-i18n')).toBe('true');
        expect(wrapper.findAll('td')[3]?.text()).toBe('工具');
        expect(wrapper.findAll('td')[3]?.attributes('data-no-i18n')).toBe('true');

        wrapper.unmount();
    });

    it('renders log filters, dates, iteration labels, and load-more states in English', async () => {
        findMcpToolLogsByServerIdMock.mockResolvedValue([
            {
                created_at: '2026-05-20T08:30:00.000Z',
                duration_ms: 25,
                error_message: null,
                id: 20,
                input: '{}',
                iteration: 3,
                message_id: 'message-with-long-id',
                output: '{"ok":true}',
                server_id: server.id,
                session_id: 'session-with-long-id',
                status: 'success',
                tool_call_id: 'tool-call-with-long-id',
                tool_name: '工具',
                updated_at: '2026-05-20T08:30:00.000Z',
            },
        ]);

        const wrapper = mountWithPinia(McpToolLogViewer, {
            props: { server },
            attachTo: document.body,
        });

        await flushMountedPromises();

        const localizer = createDomLocalizer(document.body);
        localizer.translateNow();

        expect(wrapper.text()).toContain('All');
        expect(wrapper.text()).toContain('Success');
        expect(wrapper.text()).toContain('Pending');
        expect(wrapper.find('input[placeholder="Search logs..."]').exists()).toBe(true);
        expect(wrapper.get('[data-testid="mcp-tool-log-toolbar"]').classes()).toContain(
            'flex-wrap'
        );
        expect(wrapper.get('[data-testid="mcp-tool-log-filters"]').classes()).toContain(
            'flex-wrap'
        );
        expect(wrapper.get('[data-testid="mcp-tool-log-search"]').classes()).toEqual(
            expect.arrayContaining(['w-full', 'max-w-xs', 'md:w-64'])
        );
        expect(wrapper.get('[data-testid="mcp-tool-log-header"]').classes()).toContain('flex-wrap');
        expect(wrapper.get('[data-testid="mcp-tool-log-name"]').text()).toBe('工具');
        expect(wrapper.get('[data-testid="mcp-tool-log-name"]').attributes('data-no-i18n')).toBe(
            'true'
        );
        expect(wrapper.text()).toContain('Iteration 3');
        expect(wrapper.text()).toMatch(/5\/20\/2026|May 20, 2026/);
        expect(wrapper.text()).not.toContain('迭代');

        await wrapper.get('button.w-full').trigger('click');

        const metadata = wrapper.get('[data-testid="mcp-tool-log-detail-metadata"]');
        expect(metadata.classes()).toContain('flex-wrap');
        expect(metadata.classes()).toContain('break-words');
        expect(metadata.text()).toContain('Call ID: tool-call-with-long-id');
        expect(metadata.text()).toContain('Session: session-with-long-id');
        expect(metadata.text()).toContain('Message: message-with-long-id');

        wrapper.unmount();
    });
});
