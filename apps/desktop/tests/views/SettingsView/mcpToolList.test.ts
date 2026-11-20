import { createSettingsPanelFixture } from '@tests/utils/settingsPanel';
import { createTestWindowPresentation } from '@tests/utils/windowPresentation';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach as beforePresentation } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { McpServerEntity } from '@/app/api/tools/mcpAdministration';
import { setLocale } from '@/i18n';
import McpToolList from '@/views/SettingsView/components/McpTools/components/McpToolList.vue';

let fixture: Awaited<ReturnType<typeof createSettingsPanelFixture>>;
const wrappers: ReturnType<typeof mount>[] = [];
let failToolRead = false;
afterEach(async () => {
    wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
    await fixture?.dispose();
    vi.restoreAllMocks();
});

function saveTools(values: ReturnType<typeof tool>[]) {
    for (const value of values) {
        const keys = Object.keys(value);
        fixture.database
            .prepare(
                `INSERT INTO mcp_tools (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`
            )
            .run(...Object.values(value));
    }
}

const server: McpServerEntity = {
    args: null,
    command: 'npx',
    created_at: '2026-05-20T00:00:00.000Z',
    cwd: null,
    enabled: 1,
    env: null,
    headers: null,
    id: 4,
    last_connected_at: null,
    last_error: null,
    name: 'filesystem',
    tool_timeout: 30000,
    transport_type: 'stdio' as McpServerEntity['transport_type'],
    updated_at: '2026-05-20T00:00:00.000Z',
    url: null,
    version: null,
};

function tool(overrides: Record<string, unknown> = {}) {
    return {
        created_at: '2026-05-20T00:00:00.000Z',
        description: 'Reads a file from disk',
        enabled: 1,
        id: 10,
        input_schema: JSON.stringify({
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Absolute path' },
                depth: { type: 'number' },
            },
            required: ['path'],
        }),
        name: 'read_file',
        server_id: 4,
        updated_at: '2026-05-20T00:00:00.000Z',
        ...overrides,
    };
}

function mountToolList(props: Record<string, unknown> = {}) {
    const wrapper = mount(McpToolList, { props: { server, ...props }, ...fixture.viewOptions });
    wrappers.push(wrapper);
    return wrapper;
}

async function expandFirstTool(wrapper: ReturnType<typeof mountToolList>) {
    await wrapper.get('button.w-full').trigger('click');
    await flushPromises();
}

function filterButton(wrapper: ReturnType<typeof mountToolList>, label: string) {
    const found = wrapper.findAll('button').find((node) => node.text() === label);
    expect(found).toBeDefined();
    return found!;
}

beforeEach(async () => {
    failToolRead = false;
    fixture = await createSettingsPanelFixture({
        query: {
            beforeQuery: ({ sql }) => {
                if (failToolRead && /select.*mcp_tools/i.test(sql))
                    throw new Error('read unavailable');
            },
        },
    });
    const keys = Object.keys(server);
    fixture.database
        .prepare(
            `INSERT INTO mcp_servers (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`
        )
        .run(...Object.values(server));
    setLocale('zh-CN');
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('user opens the tool list of a server', () => {
    it('user gets the tools fetched for the server they opened', async () => {
        saveTools([tool()]);
        const wrapper = mountToolList();
        await flushPromises();

        expect(wrapper.text()).toContain('read_file');
    });

    it('user sees a placeholder for every tool still loading', () => {
        const wrapper = mountToolList();

        expect(wrapper.findAll('.animate-pulse')).toHaveLength(3);
    });

    it('user sees the tools once they arrive', async () => {
        saveTools([tool()]);
        const wrapper = mountToolList();
        await flushPromises();

        expect(wrapper.text()).toContain('read_file');
        expect(wrapper.text()).toContain('Reads a file from disk');
    });

    it('user sees a hint to connect when the server has no tools yet', async () => {
        const wrapper = mountToolList();
        await flushPromises();

        expect(wrapper.get('[role="status"]').text()).toContain('暂无工具');
        expect(wrapper.get('[role="status"]').text()).toContain('连接');
    });

    it('user sees the empty state instead of a stuck loader when loading failed', async () => {
        failToolRead = true;
        const wrapper = mountToolList();
        await flushPromises();

        expect(wrapper.get('[role="status"]').text()).toContain('暂无工具');
        expect(wrapper.find('.animate-pulse').exists()).toBe(false);
    });
});

describe('user narrows the tool list', () => {
    beforeEach(() => {
        saveTools([
            tool({ id: 10, name: 'read_file', enabled: 1 }),
            tool({ id: 11, name: 'write_file', enabled: 0 }),
        ]);
    });

    it('user sees only the enabled tools after choosing enabled', async () => {
        const wrapper = mountToolList();
        await flushPromises();

        await filterButton(wrapper, '已启用').trigger('click');

        expect(wrapper.text()).toContain('read_file');
        expect(wrapper.text()).not.toContain('write_file');
    });

    it('user sees only the disabled tools after choosing disabled', async () => {
        const wrapper = mountToolList();
        await flushPromises();

        await filterButton(wrapper, '已禁用').trigger('click');

        expect(wrapper.text()).toContain('write_file');
        expect(wrapper.text()).not.toContain('read_file');
    });

    it('user sees every tool again after choosing all', async () => {
        const wrapper = mountToolList();
        await flushPromises();
        await filterButton(wrapper, '已启用').trigger('click');

        await filterButton(wrapper, '全部').trigger('click');

        expect(wrapper.text()).toContain('read_file');
        expect(wrapper.text()).toContain('write_file');
    });

    it('user sees only the tools matching what they typed', async () => {
        const wrapper = mountToolList();
        await flushPromises();

        await wrapper.get('input').setValue('write');

        expect(wrapper.text()).toContain('write_file');
        expect(wrapper.text()).not.toContain('read_file');
    });

    it('user gets a clear-filters action when nothing matches', async () => {
        const wrapper = mountToolList();
        await flushPromises();

        await wrapper.get('input').setValue('nothing-matches');

        expect(wrapper.get('[role="status"]').text()).toContain('未找到匹配的工具');
        expect(filterButton(wrapper, '清除筛选').text()).toBe('清除筛选');
    });

    it('user gets every tool back after clearing the filters', async () => {
        const wrapper = mountToolList();
        await flushPromises();
        await wrapper.get('input').setValue('nothing-matches');

        await filterButton(wrapper, '清除筛选').trigger('click');
        await flushPromises();

        expect(wrapper.text()).toContain('read_file');
        expect(wrapper.text()).toContain('write_file');
    });
});

describe('user reads a tool schema', () => {
    it('user sees the parameter names, types and required marks when expanding a tool', async () => {
        saveTools([tool()]);
        const wrapper = mountToolList();
        await flushPromises();

        await expandFirstTool(wrapper);

        const table = wrapper.get('table');
        expect(table.text()).toContain('path');
        expect(table.text()).toContain('string');
        expect(table.text()).toContain('Absolute path');
        expect(table.text()).toContain('depth');
        expect(table.text()).toContain('number');
        expect(table.text()).toContain('是');
        expect(table.text()).toContain('否');
    });

    it('user sees a dash where a parameter has no description', async () => {
        saveTools([
            tool({
                input_schema: JSON.stringify({
                    properties: { depth: { type: 'number' } },
                }),
            }),
        ]);
        const wrapper = mountToolList();
        await flushPromises();

        await expandFirstTool(wrapper);

        expect(wrapper.get('tbody tr').text()).toContain('-');
    });

    it('user sees a parameter that accepts several types listed as alternatives', async () => {
        saveTools([
            tool({
                input_schema: JSON.stringify({
                    properties: { value: { type: ['string', 'null'] } },
                }),
            }),
        ]);
        const wrapper = mountToolList();
        await flushPromises();

        await expandFirstTool(wrapper);

        expect(wrapper.get('tbody td:nth-child(2)').text()).toBe('string | null');
    });

    it('user sees a parameter restricted to a fixed set of values called an enum', async () => {
        saveTools([
            tool({
                input_schema: JSON.stringify({
                    properties: { mode: { enum: ['read', 'write'] } },
                }),
            }),
        ]);
        const wrapper = mountToolList();
        await flushPromises();

        await expandFirstTool(wrapper);

        expect(wrapper.get('tbody td:nth-child(2)').text()).toBe('enum');
    });

    it('user sees an untyped parameter listed rather than dropped', async () => {
        saveTools([
            tool({
                input_schema: JSON.stringify({ properties: { anything: {} } }),
            }),
        ]);
        const wrapper = mountToolList();
        await flushPromises();

        await expandFirstTool(wrapper);

        expect(wrapper.get('tbody td:nth-child(1)').text()).toBe('anything');
        expect(wrapper.get('tbody td:nth-child(2)').text()).toBe('any');
    });

    it('user sees the schema itself for a tool that declares no parameters', async () => {
        saveTools([tool({ input_schema: JSON.stringify({ properties: {} }) })]);
        const wrapper = mountToolList();
        await flushPromises();

        await expandFirstTool(wrapper);

        // No table without parameters, but the shape is still shown instead of a blank panel.
        expect(wrapper.find('table').exists()).toBe(false);
        expect(wrapper.get('pre').text()).toContain('"properties": {}');
    });

    it('user sees a readable schema even when the server sent unusable JSON', async () => {
        saveTools([tool({ input_schema: '{not valid json' })]);
        const wrapper = mountToolList();
        await flushPromises();

        await expandFirstTool(wrapper);

        // The parser falls back to an empty object schema rather than throwing.
        expect(wrapper.find('table').exists()).toBe(false);
        expect(wrapper.get('pre').text()).toContain('"type": "object"');
    });

    it('user sees the parameters folded away again after collapsing the tool', async () => {
        saveTools([tool()]);
        const wrapper = mountToolList();
        await flushPromises();
        await expandFirstTool(wrapper);
        expect(wrapper.find('table').exists()).toBe(true);

        await wrapper.get('button.w-full').trigger('click');

        expect(wrapper.get('.t-acc-panel').attributes('aria-hidden')).toBe('true');
    });

    it('user sees no description line for a tool the server did not describe', async () => {
        saveTools([tool({ description: null })]);
        const wrapper = mountToolList();
        await flushPromises();

        expect(wrapper.get('button.w-full').text()).toContain('read_file');
        expect(wrapper.get('button.w-full').text()).not.toContain('Reads a file');
    });
});

describe('user switches a tool on or off', () => {
    it('user gets the enabled tool switched off', async () => {
        saveTools([tool({ enabled: 1 })]);
        const wrapper = mountToolList();
        await flushPromises();

        await wrapper.get('[role="switch"]').trigger('click');
        await flushPromises();

        expect(
            fixture.database.prepare('SELECT enabled FROM mcp_tools WHERE id = 10').get()?.enabled
        ).toBe(0);
        expect(wrapper.get('[role="switch"]').attributes('aria-checked')).toBe('false');
    });

    it('user gets the disabled tool switched on', async () => {
        saveTools([tool({ enabled: 0 })]);
        const wrapper = mountToolList();
        await flushPromises();

        await wrapper.get('[role="switch"]').trigger('click');
        await flushPromises();

        expect(
            fixture.database.prepare('SELECT enabled FROM mcp_tools WHERE id = 10').get()?.enabled
        ).toBe(1);
        expect(wrapper.get('[role="switch"]').attributes('aria-checked')).toBe('true');
    });

    it('user keeps the list they had when the switch could not be saved', async () => {
        saveTools([tool({ enabled: 1 })]);
        fixture.database.exec(
            "CREATE TEMP TRIGGER reject_tool_write BEFORE UPDATE ON mcp_tools BEGIN SELECT RAISE(ABORT, 'locked'); END;"
        );
        const wrapper = mountToolList();
        await flushPromises();

        await wrapper.get('[role="switch"]').trigger('click');
        await flushPromises();

        expect(wrapper.text()).toContain('read_file');
    });
});

beforePresentation(async () => {
    (await createTestWindowPresentation('settings')).install();
});
