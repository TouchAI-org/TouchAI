import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

import { setLocale } from '@/i18n';
import SettingsBuiltInToolsSection from '@/views/SettingsView/components/BuiltInTools/index.vue';
import type { BuiltInToolEntity } from '@/views/SettingsView/components/BuiltInTools/types';

const mocks = vi.hoisted(() => ({
    findAllBuiltInToolsMock: vi.fn(),
    updateBuiltInToolMock: vi.fn(),
    updateBuiltInToolsMock: vi.fn(),
    alertErrorMock: vi.fn(),
}));

vi.mock('@database/queries', () => ({
    findAllBuiltInTools: mocks.findAllBuiltInToolsMock,
    updateBuiltInTool: mocks.updateBuiltInToolMock,
    updateBuiltInTools: mocks.updateBuiltInToolsMock,
    findBuiltInToolLogsByToolId: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/views/SettingsView/components/BuiltInTools/components/BuiltInToolList.vue', () => ({
    default: {
        name: 'BuiltInToolList',
        props: ['tools', 'selectedToolId', 'togglingToolIds'],
        emits: ['select', 'toggle-enabled'],
        template: '<div data-testid="tool-list"></div>',
    },
}));

vi.mock('@/views/SettingsView/components/BuiltInTools/components/BuiltInToolConfig.vue', () => ({
    default: {
        name: 'BuiltInToolConfig',
        props: ['tool', 'saving'],
        emits: ['save'],
        template: '<div data-testid="tool-config"></div>',
    },
}));

vi.mock('@/views/SettingsView/components/BuiltInTools/components/BuiltInToolLogViewer.vue', () => ({
    default: {
        name: 'BuiltInToolLogViewer',
        props: ['tool'],
        template: '<div data-testid="tool-logs"></div>',
    },
}));

vi.mock('@components/AlertMessage.vue', () => ({
    default: {
        name: 'AlertMessage',
        methods: {
            error: mocks.alertErrorMock,
        },
        template: '<div data-testid="alert-message"></div>',
    },
}));

function createTool(
    id: number,
    toolId: string,
    patch: Partial<BuiltInToolEntity> = {}
): BuiltInToolEntity {
    return {
        id,
        tool_id: toolId,
        display_name: toolId,
        description: null,
        enabled: 1,
        risk_level: 'medium',
        config_json: null,
        last_used_at: null,
        created_at: '2026-06-03T00:00:00.000Z',
        updated_at: '2026-06-03T00:00:00.000Z',
        ...patch,
    };
}

function createBrowserTools() {
    return [createTool(1, 'browser'), createTool(2, 'bash')];
}

async function mountSection(tools = createBrowserTools()) {
    mocks.findAllBuiltInToolsMock.mockResolvedValue(tools);
    mocks.updateBuiltInToolMock.mockImplementation(
        async (id: number, patch: Partial<BuiltInToolEntity>) => {
            const tool = tools.find((candidate) => candidate.id === id);
            return tool
                ? { ...tool, ...patch, id, updated_at: '2026-06-03T00:00:01.000Z' }
                : undefined;
        }
    );
    mocks.updateBuiltInToolsMock.mockImplementation(
        async (ids: number[], patch: Partial<BuiltInToolEntity>) =>
            ids.map((id) => {
                const tool = tools.find((candidate) => candidate.id === id);
                if (!tool) {
                    throw new Error(`missing tool ${id}`);
                }
                return { ...tool, ...patch, id, updated_at: '2026-06-03T00:00:01.000Z' };
            })
    );

    const wrapper = mount(SettingsBuiltInToolsSection, {
        global: {
            stubs: {
                SectionTabs: {
                    props: ['modelValue', 'tabs'],
                    emits: ['update:modelValue'],
                    template: '<div data-testid="section-tabs"></div>',
                },
                AppIcon: true,
                LoadingState: true,
            },
        },
    });
    await nextTick();
    await flushPromises();
    await nextTick();
    return wrapper;
}

describe('settings built-in browser tool group behavior', () => {
    beforeEach(() => {
        setLocale('en-US');
        vi.clearAllMocks();
        class ResizeObserverMock {
            observe = vi.fn();
            unobserve = vi.fn();
            disconnect = vi.fn();
        }
        vi.stubGlobal('ResizeObserver', ResizeObserverMock);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('toggles the consolidated browser automation row', async () => {
        const wrapper = await mountSection();
        const toolList = wrapper.getComponent({ name: 'BuiltInToolList' });

        await toolList.vm.$emit('toggle-enabled', 1, false);
        await flushPromises();
        await nextTick();

        expect(mocks.updateBuiltInToolMock).toHaveBeenCalledTimes(1);
        expect(mocks.updateBuiltInToolMock).toHaveBeenCalledWith(1, { enabled: 0 });
        expect(mocks.updateBuiltInToolsMock).not.toHaveBeenCalled();
    });

    it('does not show built-in tool config for browser rows because configuration lives in Browser settings', async () => {
        const wrapper = await mountSection();

        expect(wrapper.findComponent({ name: 'BuiltInToolConfig' }).exists()).toBe(false);
        expect(wrapper.findComponent({ name: 'BuiltInToolLogViewer' }).exists()).toBe(true);

        expect(mocks.updateBuiltInToolsMock).not.toHaveBeenCalled();
        expect(mocks.updateBuiltInToolMock).not.toHaveBeenCalled();
    });

    it('does not fan out unrelated tool config updates', async () => {
        const tools = createBrowserTools();
        const wrapper = await mountSection(tools);
        const toolList = wrapper.getComponent({ name: 'BuiltInToolList' });

        await toolList.vm.$emit('select', tools[1]);
        await wrapper.getComponent({ name: 'BuiltInToolConfig' }).vm.$emit('save', {
            config_json: '{"timeoutMs":15000}',
        });
        await flushPromises();
        await nextTick();

        expect(mocks.updateBuiltInToolMock).toHaveBeenCalledTimes(1);
        expect(mocks.updateBuiltInToolMock).toHaveBeenCalledWith(2, {
            config_json: '{"timeoutMs":15000}',
        });
        expect(mocks.updateBuiltInToolsMock).not.toHaveBeenCalled();
    });

    it('reports browser update failures', async () => {
        const wrapper = await mountSection();
        const toolList = wrapper.getComponent({ name: 'BuiltInToolList' });
        mocks.updateBuiltInToolMock.mockRejectedValue(new Error('browser update failed'));

        await wrapper
            .getComponent({ name: 'BuiltInToolList' })
            .vm.$emit('toggle-enabled', 1, false);
        await flushPromises();
        await nextTick();

        expect(mocks.updateBuiltInToolMock).toHaveBeenCalledTimes(1);
        expect(mocks.updateBuiltInToolMock).toHaveBeenCalledWith(1, { enabled: 0 });
        expect(mocks.updateBuiltInToolsMock).not.toHaveBeenCalled();
        expect(mocks.alertErrorMock).toHaveBeenCalledWith(
            expect.stringContaining('Failed to update'),
            6000
        );
        expect(
            toolList.props('tools').filter((tool: BuiltInToolEntity) => tool.tool_id === 'browser')
        ).toEqual([expect.objectContaining({ tool_id: 'browser', enabled: 1 })]);
    });
});
