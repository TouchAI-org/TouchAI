import { createSettingsPanelFixture, openSettingsSelect } from '@tests/utils/settingsPanel';
import { getTauriInvokeCalls } from '@tests/utils/tauri';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createMcpToolLog } from '@/database/queries/mcpToolLogs';
import { setLocale } from '@/i18n';
import { createDomLocalizer } from '@/i18n/domLocalizer';
import McpServerConfig from '@/views/SettingsView/components/McpTools/components/McpServerConfig.vue';
import McpToolList from '@/views/SettingsView/components/McpTools/components/McpToolList.vue';
import McpToolLogViewer from '@/views/SettingsView/components/McpTools/components/McpToolLogViewer.vue';
import McpToolsSection from '@/views/SettingsView/components/McpTools/index.vue';

let fixture: Awaited<ReturnType<typeof createSettingsPanelFixture>>;
const wrappers: ReturnType<typeof mount>[] = [];
afterEach(async () => {
    wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
    await fixture?.dispose();
});
function saveTools(values: Array<Record<string, string | number | null>>) {
    fixture.database
        .prepare(
            "INSERT INTO mcp_servers (id, name, transport_type) VALUES (1, 'fixture', 'stdio')"
        )
        .run();
    for (const value of values) {
        const keys = Object.keys(value);
        fixture.database
            .prepare(
                `INSERT INTO mcp_tools (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`
            )
            .run(...Object.values(value));
    }
}
async function setMcpLogs(values: Array<Record<string, unknown>>) {
    fixture.database
        .exec(`INSERT INTO sessions (id, session_id, title, model) VALUES (321, 'fixture', 'Fixture', 'fixture');
        INSERT INTO messages (id, session_id, role) VALUES (654, 321, 'tool_call');`);
    for (const value of values)
        await createMcpToolLog({ ...value, session_id: 321, message_id: 654 } as Parameters<
            typeof createMcpToolLog
        >[0]);
}
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
    const wrapper = mount(component, { ...fixture.viewOptions, ...options });
    wrappers.push(wrapper);
    return wrapper;
}

const flushMountedPromises = flushPromises;

describe('given MCP settings in English with long server content', () => {
    beforeEach(async () => {
        fixture = await createSettingsPanelFixture();
        setLocale('en-US');
        document.documentElement.lang = 'en-US';
    });

    it('user sees section tabs, buttons, and empty states in English', async () => {
        const wrapper = mountWithPinia(McpToolsSection);

        await flushMountedPromises();

        const emptyState = wrapper.get('[data-testid="empty-state"]');
        expect(wrapper.get('[data-testid="settings-mcp-tools-panel"]').isVisible()).toBe(false);
        expect(emptyState.text()).toContain('No servers yet');
        expect(emptyState.text()).toContain('Click the button below to add a server');
        expect(emptyState.get('button').text()).toBe('Add server');
        expect(wrapper.text()).not.toContain('暂无服务器');
    });

    it('user sees configuration labels, placeholders, and transport descriptions in English', async () => {
        const wrapper = mountWithPinia(McpServerConfig, {
            props: { server },
        });

        expect(wrapper.text()).toContain('Server configuration');
        expect(
            (wrapper.get('input[placeholder="Server name"]').element as HTMLInputElement).value
        ).toBe(server.name);
        expect(wrapper.text()).toContain('Name');
        expect(wrapper.text()).toContain('Transport type');
        const options = await openSettingsSelect(wrapper.get('[role=combobox]'));
        expect(options.map((option) => option.text()).join(' ')).toContain('Standard input/output');
        expect(options.map((option) => option.text()).join(' ')).toContain(
            'Compatible with Streamable HTTP and SSE'
        );
        expect(wrapper.text()).toContain('Tool timeout (ms)');
        expect(wrapper.find('input[placeholder="Server name"]').exists()).toBe(true);
        expect(wrapper.find('input[placeholder="Example: npx"]').exists()).toBe(true);
        expect(wrapper.find('input[placeholder="Example: /path/to/directory"]').exists()).toBe(
            true
        );
        expect(wrapper.text()).not.toContain('服务器配置');
    });

    it('user sees tool filters, empty states, parameter labels, and wrapping classes in English', async () => {
        saveTools([
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

    it('user retains the original dynamic tool content when the global localizer runs', async () => {
        saveTools([
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

    it('user sees log filters and header dates in English without iteration labels', async () => {
        await setMcpLogs([
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
            expect.arrayContaining(['min-w-[16rem]', 'flex-1'])
        );
        expect(wrapper.get('[data-testid="tool-log-header"]').classes()).toContain('flex-wrap');
        expect(wrapper.get('[data-testid="tool-log-name"]').text()).toBe('工具');
        expect(wrapper.get('[data-testid="tool-log-name"]').attributes('data-no-i18n')).toBe(
            'true'
        );
        const timestamp = wrapper.get('[data-testid="tool-log-header"] time');
        expect(timestamp.text()).toMatch(/5\/20\/2026|May 20, 2026/);
        expect(timestamp.attributes('datetime')).toBe('2026-05-20T08:30:00.000Z');
        expect(wrapper.text()).not.toContain('Iteration');
        expect(wrapper.text()).not.toContain('迭代');

        // 展开之前不应读取完整日志正文。
        const detailReads = () =>
            getTauriInvokeCalls('database_query').filter((call) => {
                const request = (call.payload as { request: { sql: string; params: unknown[] } })
                    .request;
                return /where.*"message_parts"."id" = \?/i.test(request.sql);
            });
        expect(detailReads()).toHaveLength(0);

        await wrapper.get('button.w-full').trigger('click');
        await flushMountedPromises();

        expect(detailReads()).toHaveLength(1);
        expect(wrapper.text()).toContain('ok');
        expect(wrapper.find('[data-testid="mcp-tool-log-detail-metadata"]').exists()).toBe(false);
        expect(wrapper.text()).not.toContain('tool-call-with-long-id');
        expect(wrapper.text()).not.toContain('session-with-long-id');
        expect(wrapper.text()).not.toContain('message-with-long-id');

        wrapper.unmount();
    });
});
