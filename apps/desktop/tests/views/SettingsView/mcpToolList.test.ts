import type { McpServerEntity } from '@database/types';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import McpToolList from '@/views/SettingsView/components/McpTools/components/McpToolList.vue';

/*
 * The tool list is what a user reads to decide whether to enable an MCP tool: the
 * name, the description, and the parameters the model will have to fill in. The
 * parameter table is built from the tool's JSON schema, so every branch asserted
 * here is a different schema shape a real server can return.
 */

const { updateMcpToolMock } = vi.hoisted(() => ({ updateMcpToolMock: vi.fn() }));

const store = await vi.hoisted(async () => {
    const { reactive } = await import('vue');
    return reactive({
        tools: {} as Record<number, Array<Record<string, unknown>>>,
        loadServerTools: vi.fn(async () => undefined),
        getServerTools(id: number) {
            return (this.tools as Record<number, Array<Record<string, unknown>>>)[id] ?? [];
        },
    });
});

vi.mock('@/stores/mcp', () => ({
    useMcpStore: () => store,
}));

vi.mock('@database/queries', () => ({
    updateMcpTool: updateMcpToolMock,
}));

vi.mock('@components/AppIcon.vue', () => ({
    default: {
        name: 'AppIcon',
        props: ['name'],
        template: '<span data-testid="app-icon" :data-name="name" />',
    },
}));

vi.mock('@components/MotionCollapse.vue', () => ({
    default: {
        name: 'MotionCollapse',
        props: ['open', 'lazy'],
        template: '<div v-if="open"><slot /></div>',
    },
}));

vi.mock('@components/EmptyState.vue', () => ({
    default: {
        name: 'EmptyState',
        props: ['title', 'description', 'icon'],
        template: `
            <div data-testid="empty-state">
                <p data-testid="empty-title">{{ title }}</p>
                <p data-testid="empty-description">{{ description }}</p>
                <slot name="actions" />
            </div>
        `,
    },
}));

vi.mock('@components/ui/switch', () => ({
    Switch: {
        name: 'UiSwitch',
        props: ['modelValue', 'size'],
        emits: ['update:model-value'],
        template:
            '<button data-testid="tool-switch" @click="$emit(\'update:model-value\', !modelValue)" />',
    },
}));

vi.mock('@components/ui/button', () => ({
    Button: {
        name: 'UiButton',
        template: '<button data-testid="ui-button"><slot /></button>',
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
    return mount(McpToolList, { props: { server, ...props } });
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

beforeEach(() => {
    setLocale('zh-CN');
    store.tools = {};
    store.loadServerTools = vi.fn(async () => undefined);
    updateMcpToolMock.mockReset();
    updateMcpToolMock.mockResolvedValue(undefined);
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('user opens the tool list of a server', () => {
    it('user gets the tools fetched for the server they opened', async () => {
        mountToolList();
        await flushPromises();

        expect(store.loadServerTools).toHaveBeenCalledWith(4);
    });

    it('user sees a placeholder for every tool still loading', () => {
        const wrapper = mountToolList();

        expect(wrapper.findAll('.animate-pulse')).toHaveLength(3);
    });

    it('user sees the tools once they arrive', async () => {
        store.tools = { 4: [tool()] };
        const wrapper = mountToolList();
        await flushPromises();

        expect(wrapper.text()).toContain('read_file');
        expect(wrapper.text()).toContain('Reads a file from disk');
    });

    it('user sees a hint to connect when the server has no tools yet', async () => {
        const wrapper = mountToolList();
        await flushPromises();

        expect(wrapper.get('[data-testid="empty-title"]').text()).toBe('暂无工具');
        expect(wrapper.get('[data-testid="empty-description"]').text()).toContain('连接');
    });

    it('user sees the empty state instead of a stuck loader when loading failed', async () => {
        store.loadServerTools = vi.fn(async () => {
            throw new Error('network down');
        });
        const wrapper = mountToolList();
        await flushPromises();

        expect(wrapper.get('[data-testid="empty-title"]').text()).toBe('暂无工具');
        expect(wrapper.find('.animate-pulse').exists()).toBe(false);
    });
});

describe('user narrows the tool list', () => {
    beforeEach(() => {
        store.tools = {
            4: [
                tool({ id: 10, name: 'read_file', enabled: 1 }),
                tool({ id: 11, name: 'write_file', enabled: 0 }),
            ],
        };
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

        expect(wrapper.get('[data-testid="empty-title"]').text()).toBe('未找到匹配的工具');
        expect(wrapper.get('[data-testid="ui-button"]').text()).toBe('清除筛选');
    });

    it('user gets every tool back after clearing the filters', async () => {
        const wrapper = mountToolList();
        await flushPromises();
        await wrapper.get('input').setValue('nothing-matches');

        await wrapper.get('[data-testid="ui-button"]').trigger('click');
        await flushPromises();

        expect(wrapper.text()).toContain('read_file');
        expect(wrapper.text()).toContain('write_file');
    });
});

describe('user reads a tool schema', () => {
    it('user sees the parameter names, types and required marks when expanding a tool', async () => {
        store.tools = { 4: [tool()] };
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
        store.tools = {
            4: [
                tool({
                    input_schema: JSON.stringify({
                        properties: { depth: { type: 'number' } },
                    }),
                }),
            ],
        };
        const wrapper = mountToolList();
        await flushPromises();

        await expandFirstTool(wrapper);

        expect(wrapper.get('tbody tr').text()).toContain('-');
    });

    it('user sees a parameter that accepts several types listed as alternatives', async () => {
        store.tools = {
            4: [
                tool({
                    input_schema: JSON.stringify({
                        properties: { value: { type: ['string', 'null'] } },
                    }),
                }),
            ],
        };
        const wrapper = mountToolList();
        await flushPromises();

        await expandFirstTool(wrapper);

        expect(wrapper.get('tbody td:nth-child(2)').text()).toBe('string | null');
    });

    it('user sees a parameter restricted to a fixed set of values called an enum', async () => {
        store.tools = {
            4: [
                tool({
                    input_schema: JSON.stringify({
                        properties: { mode: { enum: ['read', 'write'] } },
                    }),
                }),
            ],
        };
        const wrapper = mountToolList();
        await flushPromises();

        await expandFirstTool(wrapper);

        expect(wrapper.get('tbody td:nth-child(2)').text()).toBe('enum');
    });

    it('user sees an untyped parameter listed rather than dropped', async () => {
        store.tools = {
            4: [
                tool({
                    input_schema: JSON.stringify({ properties: { anything: {} } }),
                }),
            ],
        };
        const wrapper = mountToolList();
        await flushPromises();

        await expandFirstTool(wrapper);

        expect(wrapper.get('tbody td:nth-child(1)').text()).toBe('anything');
        expect(wrapper.get('tbody td:nth-child(2)').text()).toBe('any');
    });

    it('user sees the schema itself for a tool that declares no parameters', async () => {
        store.tools = {
            4: [tool({ input_schema: JSON.stringify({ properties: {} }) })],
        };
        const wrapper = mountToolList();
        await flushPromises();

        await expandFirstTool(wrapper);

        // No table without parameters, but the shape is still shown instead of a blank panel.
        expect(wrapper.find('table').exists()).toBe(false);
        expect(wrapper.get('pre').text()).toContain('"properties": {}');
    });

    it('user sees a readable schema even when the server sent unusable JSON', async () => {
        store.tools = { 4: [tool({ input_schema: '{not valid json' })] };
        const wrapper = mountToolList();
        await flushPromises();

        await expandFirstTool(wrapper);

        // The parser falls back to an empty object schema rather than throwing.
        expect(wrapper.find('table').exists()).toBe(false);
        expect(wrapper.get('pre').text()).toContain('"type": "object"');
    });

    it('user sees the parameters folded away again after collapsing the tool', async () => {
        store.tools = { 4: [tool()] };
        const wrapper = mountToolList();
        await flushPromises();
        await expandFirstTool(wrapper);
        expect(wrapper.find('table').exists()).toBe(true);

        await wrapper.get('button.w-full').trigger('click');

        expect(wrapper.find('table').exists()).toBe(false);
    });

    it('user sees no description line for a tool the server did not describe', async () => {
        store.tools = { 4: [tool({ description: null })] };
        const wrapper = mountToolList();
        await flushPromises();

        expect(wrapper.get('button.w-full').text()).toContain('read_file');
        expect(wrapper.get('button.w-full').text()).not.toContain('Reads a file');
    });
});

describe('user switches a tool on or off', () => {
    it('user gets the enabled tool switched off', async () => {
        store.tools = { 4: [tool({ enabled: 1 })] };
        const wrapper = mountToolList();
        await flushPromises();

        await wrapper.get('[data-testid="tool-switch"]').trigger('click');
        await flushPromises();

        expect(updateMcpToolMock).toHaveBeenCalledWith(10, { enabled: 0 });
        expect(store.loadServerTools).toHaveBeenCalledTimes(2);
    });

    it('user gets the disabled tool switched on', async () => {
        store.tools = { 4: [tool({ enabled: 0 })] };
        const wrapper = mountToolList();
        await flushPromises();

        await wrapper.get('[data-testid="tool-switch"]').trigger('click');
        await flushPromises();

        expect(updateMcpToolMock).toHaveBeenCalledWith(10, { enabled: 1 });
    });

    it('user keeps the list they had when the switch could not be saved', async () => {
        store.tools = { 4: [tool({ enabled: 1 })] };
        updateMcpToolMock.mockRejectedValue(new Error('locked'));
        const wrapper = mountToolList();
        await flushPromises();

        await wrapper.get('[data-testid="tool-switch"]').trigger('click');
        await flushPromises();

        expect(wrapper.text()).toContain('read_file');
    });
});
