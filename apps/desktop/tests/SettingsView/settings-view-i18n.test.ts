import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';

import { setLocale } from '@/i18n';
import SettingsView from '@/views/SettingsView/index.vue';

const { setTitleMock } = vi.hoisted(() => ({
    setTitleMock: vi.fn(async () => undefined),
}));

vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => ({
        minimize: vi.fn(),
        close: vi.fn(),
        setTitle: setTitleMock,
    }),
}));

vi.mock('@composables/useScrollbarStabilizer', () => ({
    useScrollbarStabilizer: vi.fn(),
}));

vi.mock('@components/AppIcon.vue', () => ({
    default: {
        name: 'AppIcon',
        props: ['name'],
        template: '<span data-testid="app-icon" />',
    },
}));

const AsyncNever = defineComponent({
    async setup() {
        await new Promise(() => undefined);
        return () => h('div');
    },
});

vi.mock('@/views/SettingsView/components/General/index.vue', () => ({
    __esModule: true,
    default: AsyncNever,
}));
vi.mock('@/views/SettingsView/components/AiServices/index.vue', () => ({
    __esModule: true,
    default: AsyncNever,
}));
vi.mock('@/views/SettingsView/components/BuiltInTools/index.vue', () => ({
    __esModule: true,
    default: AsyncNever,
}));
vi.mock('@/views/SettingsView/components/McpTools/index.vue', () => ({
    __esModule: true,
    default: AsyncNever,
}));
vi.mock('@/views/SettingsView/components/DataManagement/index.vue', () => ({
    __esModule: true,
    default: AsyncNever,
}));
vi.mock('@/views/SettingsView/components/About/index.vue', () => ({
    __esModule: true,
    default: AsyncNever,
}));

async function flushMountedPromises() {
    for (let index = 0; index < 4; index += 1) {
        await Promise.resolve();
    }
}

describe('SettingsView lazy loading i18n', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setLocale('zh-CN');
    });

    it('renders lazy-loading placeholders in English when the active locale is English', async () => {
        setLocale('en-US');

        const wrapper = mount(SettingsView, {
            global: {
                stubs: {
                    Transition: false,
                },
            },
        });

        await flushMountedPromises();
        expect(wrapper.text()).toContain('Loading general settings...');
        expect(setTitleMock).toHaveBeenCalledWith('TouchAI - Settings');

        await wrapper.get('[data-testid="settings-nav-ai-services"]').trigger('click');
        expect(wrapper.text()).toContain('Loading model service settings...');

        await wrapper.get('[data-testid="settings-nav-built-in-tools"]').trigger('click');
        expect(wrapper.text()).toContain('Loading built-in tools...');

        await wrapper.get('[data-testid="settings-nav-mcp-tools"]').trigger('click');
        expect(wrapper.text()).toContain('Loading MCP tools...');

        await wrapper.get('[data-testid="settings-nav-data-management"]').trigger('click');
        expect(wrapper.text()).toContain('Loading data management...');

        await wrapper.get('[data-testid="settings-nav-about"]').trigger('click');
        expect(wrapper.text()).toContain('Loading about page...');

        expect(wrapper.text()).not.toContain('正在加载');
    });
});
