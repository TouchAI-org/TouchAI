import { flushPromises, shallowMount } from '@vue/test-utils';
import { afterEach, beforeEach, vi } from 'vitest';

import SettingsWindowView from '@/views/SettingsView/index.vue';

const windowApiMock = vi.hoisted(() => ({
    currentWindow: {
        close: vi.fn().mockResolvedValue(undefined),
        isMaximized: vi.fn().mockResolvedValue(false),
        maximize: vi.fn().mockResolvedValue(undefined),
        minimize: vi.fn().mockResolvedValue(undefined),
        unmaximize: vi.fn().mockResolvedValue(undefined),
    },
}));

vi.mock('@composables/useScrollbarStabilizer', () => ({
    useScrollbarStabilizer: vi.fn(),
}));

vi.mock('@components/AppIcon.vue', () => ({
    default: {
        name: 'AppIconStub',
        props: ['name'],
        template: '<span data-testid="app-icon" :data-name="name" />',
    },
}));

vi.mock('@components/LoadingState.vue', () => ({
    default: {
        name: 'LoadingState',
        props: ['message', 'fill', 'variant'],
        template:
            '<div data-testid="loading-state" :data-message="message" :data-fill="fill" :data-variant="variant">{{ message }}</div>',
    },
}));

vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => windowApiMock.currentWindow,
}));

vi.mock('@/views/SettingsView/components/General/index.vue', () => ({
    default: {
        name: 'GeneralView',
        template: '<section data-testid="general-view-stub" />',
    },
}));

vi.mock('@/views/SettingsView/components/AiServices/index.vue', () => ({
    default: {
        name: 'AiServicesView',
        template: '<section data-testid="ai-services-view-stub" />',
    },
}));

vi.mock('@/views/SettingsView/components/BuiltInTools/index.vue', () => ({
    default: {
        name: 'BuiltInToolsView',
        template: '<section data-testid="built-in-tools-view-stub" />',
    },
}));

vi.mock('@/views/SettingsView/components/McpTools/index.vue', () => ({
    default: {
        name: 'McpToolsView',
        template: '<section data-testid="mcp-tools-view-stub" />',
    },
}));

vi.mock('@/views/SettingsView/components/DataManagement/index.vue', () => ({
    default: {
        name: 'DataManagementView',
        template: '<section data-testid="data-management-view-stub" />',
    },
}));

vi.mock('@/views/SettingsView/components/NavigationSidebar.vue', () => ({
    default: {
        name: 'NavigationSidebar',
        props: ['activeSection'],
        emits: ['navigate', 'ready'],
        mounted(this: { $emit: (event: 'ready') => void }) {
            this.$emit('ready');
        },
        template: '<aside data-testid="settings-sidebar-stub" />',
    },
}));

const navigationSidebarStub = {
    name: 'NavigationSidebar',
    props: ['activeSection'],
    emits: ['navigate', 'ready'],
    mounted(this: { $emit: (event: 'ready') => void }) {
        this.$emit('ready');
    },
    template: '<aside data-testid="settings-sidebar-stub" />',
};

const mountSettingsWindow = (suspenseTemplate = '<div><slot /></div>') =>
    shallowMount(SettingsWindowView, {
        global: {
            stubs: {
                NavigationSidebar: navigationSidebarStub,
                Suspense: {
                    template: suspenseTemplate,
                },
            },
        },
    });

describe('SettingsWindowView', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        windowApiMock.currentWindow.close.mockClear();
        windowApiMock.currentWindow.isMaximized.mockResolvedValue(false);
        windowApiMock.currentWindow.isMaximized.mockClear();
        windowApiMock.currentWindow.maximize.mockClear();
        windowApiMock.currentWindow.minimize.mockClear();
        windowApiMock.currentWindow.unmaximize.mockClear();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('shows a shared brand loading state before rendering the settings shell', async () => {
        const wrapper = mountSettingsWindow();

        expect(wrapper.get('[data-testid="settings-loading-screen"]').attributes('variant')).toBe(
            'brand'
        );
        expect(wrapper.get('[data-testid="settings-loading-screen"]').attributes('fill')).toBe(
            'screen'
        );
        expect(wrapper.find('[data-testid="settings-sidebar-stub"]').exists()).toBe(true);

        await vi.runAllTimersAsync();
        await flushPromises();

        expect(wrapper.find('[data-testid="settings-window-header"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="settings-window-title"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="settings-window-controls"]').exists()).toBe(true);
        expect(wrapper.get('[data-testid="settings-window-minimize"]').attributes('title')).toBe(
            '最小化'
        );
        expect(wrapper.get('[data-testid="settings-window-maximize"]').attributes('title')).toBe(
            '最大化'
        );
        expect(wrapper.get('[data-testid="settings-window-close"]').attributes('title')).toBe(
            '关闭'
        );
        expect(
            wrapper.get('[data-testid="settings-content-drag-region"]').attributes()
        ).toHaveProperty('data-tauri-drag-region');
        expect(
            (
                wrapper.get('[data-testid="settings-shell-card"]').element as HTMLElement
            ).querySelector('[data-testid="settings-sidebar-stub"]')
        ).toBeNull();
    });

    it('does not render reference-app back navigation and keeps native window controls', async () => {
        const wrapper = mountSettingsWindow();

        await vi.runAllTimersAsync();
        await flushPromises();

        expect(wrapper.text()).not.toContain('返回');
        await wrapper.get('[data-testid="settings-window-minimize"]').trigger('click');
        await wrapper.get('[data-testid="settings-window-maximize"]').trigger('click');
        await wrapper.get('[data-testid="settings-window-close"]').trigger('click');

        expect(windowApiMock.currentWindow.minimize).toHaveBeenCalledTimes(1);
        expect(windowApiMock.currentWindow.isMaximized).toHaveBeenCalledTimes(1);
        expect(windowApiMock.currentWindow.maximize).toHaveBeenCalledTimes(1);
        expect(windowApiMock.currentWindow.close).toHaveBeenCalledTimes(1);
    });

    it('clears the startup delay timer when the window unmounts before becoming ready', () => {
        const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

        const wrapper = mountSettingsWindow();

        wrapper.unmount();

        expect(clearTimeoutSpy).toHaveBeenCalled();
    });

    it('renders the shell card while each section is still resolving', async () => {
        const wrapper = mountSettingsWindow('<div><slot name="fallback" /></div>');

        await vi.runAllTimersAsync();
        await flushPromises();

        const nav = wrapper.findComponent({ name: 'NavigationSidebar' });
        const loadingState = () => wrapper.get('loading-state-stub');

        expect(loadingState().attributes('variant')).toBe('brand');
        expect(loadingState().attributes('fill')).toBe('min');
        expect(loadingState().attributes('message')).toBeUndefined();

        nav.vm.$emit('navigate', 'ai-services');
        await flushPromises();
        expect(loadingState().attributes('variant')).toBe('brand');

        nav.vm.$emit('navigate', 'built-in-tools');
        await flushPromises();
        expect(loadingState().attributes('variant')).toBe('brand');

        nav.vm.$emit('navigate', 'mcp-tools');
        await flushPromises();
        expect(loadingState().attributes('variant')).toBe('brand');

        nav.vm.$emit('navigate', 'data-management');
        await flushPromises();
        expect(loadingState().attributes('variant')).toBe('brand');
    });

    it('switches between the ready section views inside the shared shell card', async () => {
        const wrapper = mountSettingsWindow();

        await vi.runAllTimersAsync();
        await flushPromises();

        const nav = wrapper.findComponent({ name: 'NavigationSidebar' });

        expect(wrapper.find('general-view-stub').exists()).toBe(true);

        nav.vm.$emit('navigate', 'ai-services');
        await flushPromises();
        expect(wrapper.find('ai-services-view-stub').exists()).toBe(true);

        nav.vm.$emit('navigate', 'built-in-tools');
        await flushPromises();
        expect(wrapper.find('built-in-tools-view-stub').exists()).toBe(true);

        nav.vm.$emit('navigate', 'mcp-tools');
        await flushPromises();
        expect(wrapper.find('mcp-tools-view-stub').exists()).toBe(true);

        nav.vm.$emit('navigate', 'data-management');
        await flushPromises();
        expect(wrapper.find('data-management-view-stub').exists()).toBe(true);
    });
});
