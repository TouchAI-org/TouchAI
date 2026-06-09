import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import SettingsView from '@/views/SettingsView/index.vue';

const { asyncViewControls, setTitleMock } = vi.hoisted(() => {
    const pendingResolvers = new Set<() => void>();

    return {
        asyncViewControls: {
            waitForResolve() {
                return new Promise<void>((resolve) => {
                    pendingResolvers.add(resolve);
                });
            },
            resolveAll() {
                for (const resolve of pendingResolvers) {
                    resolve();
                }
                pendingResolvers.clear();
            },
        },
        setTitleMock: vi.fn(async () => undefined),
    };
});

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

vi.mock('@/views/SettingsView/components/General/index.vue', () => ({
    __esModule: true,
    default: {
        name: 'GeneralViewStub',
        async setup() {
            await asyncViewControls.waitForResolve();
            return () => null;
        },
    },
}));
vi.mock('@/views/SettingsView/components/AiServices/index.vue', () => ({
    __esModule: true,
    default: {
        name: 'AiServicesViewStub',
        async setup() {
            await asyncViewControls.waitForResolve();
            return () => null;
        },
    },
}));
vi.mock('@/views/SettingsView/components/Memory/index.vue', () => ({
    __esModule: true,
    default: {
        name: 'MemoryViewStub',
        async setup() {
            await asyncViewControls.waitForResolve();
            return () => null;
        },
    },
}));
vi.mock('@/views/SettingsView/components/BuiltInTools/index.vue', () => ({
    __esModule: true,
    default: {
        name: 'BuiltInToolsViewStub',
        async setup() {
            await asyncViewControls.waitForResolve();
            return () => null;
        },
    },
}));
vi.mock('@/views/SettingsView/components/McpTools/index.vue', () => ({
    __esModule: true,
    default: {
        name: 'McpToolsViewStub',
        async setup() {
            await asyncViewControls.waitForResolve();
            return () => null;
        },
    },
}));
vi.mock('@/views/SettingsView/components/DataManagement/index.vue', () => ({
    __esModule: true,
    default: {
        name: 'DataManagementViewStub',
        async setup() {
            await asyncViewControls.waitForResolve();
            return () => null;
        },
    },
}));

async function flushMountedPromises() {
    for (let index = 0; index < 4; index += 1) {
        await Promise.resolve();
    }
}

describe('SettingsView lazy loading i18n', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        asyncViewControls.resolveAll();
        setLocale('zh-CN');
    });

    afterEach(() => {
        asyncViewControls.resolveAll();
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

        await wrapper.get('[data-testid="settings-nav-memory"]').trigger('click');
        expect(wrapper.text()).toContain('Loading memory settings...');

        await wrapper.get('[data-testid="settings-nav-built-in-tools"]').trigger('click');
        expect(wrapper.text()).toContain('Loading built-in tools...');

        await wrapper.get('[data-testid="settings-nav-mcp-tools"]').trigger('click');
        expect(wrapper.text()).toContain('Loading MCP tools...');

        await wrapper.get('[data-testid="settings-nav-data-management"]').trigger('click');
        expect(wrapper.text()).toContain('Loading data management...');

        expect(wrapper.find('[data-testid="settings-nav-about"]').exists()).toBe(false);

        expect(wrapper.text()).not.toContain('正在加载');
    });
});
