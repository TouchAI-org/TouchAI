import { flushPromises, mount, shallowMount } from '@vue/test-utils';
import { afterEach, beforeEach, vi } from 'vitest';
import { h, onMounted, ref } from 'vue';

import { AppEvent, eventService } from '@/services/EventService';
import SettingsWindowView from '@/views/SettingsView/index.vue';

const windowApiMock = vi.hoisted(() => ({
    currentWindow: {
        close: vi.fn().mockResolvedValue(undefined),
        isMaximized: vi.fn().mockResolvedValue(false),
        maximize: vi.fn().mockResolvedValue(undefined),
        minimize: vi.fn().mockResolvedValue(undefined),
        onResized: vi.fn().mockResolvedValue(() => undefined),
        startDragging: vi.fn().mockResolvedValue(undefined),
        unmaximize: vi.fn().mockResolvedValue(undefined),
    },
}));

const sectionMountMocks = vi.hoisted(() => ({
    aiServices: vi.fn(),
    builtInTools: vi.fn(),
    revealAiServicesTarget: undefined as (() => void) | undefined,
}));

const updateServiceMock = vi.hoisted(() => ({
    checkNow: vi.fn().mockResolvedValue(true),
    checkAndOpenUpdates: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@services/AppUpdateService', () => ({
    appUpdateService: updateServiceMock,
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
    __esModule: true,
    default: {
        name: 'GeneralView',
        emits: ['show-update-settings'],
        setup(_: unknown, { expose }: { expose: (exposed: object) => void }) {
            expose({ checkAndOpenUpdates: updateServiceMock.checkAndOpenUpdates });
            return {};
        },
        template: '<section data-testid="general-view-stub" />',
    },
}));

vi.mock('@/views/SettingsView/components/Shortcuts/index.vue', () => ({
    __esModule: true,
    default: {
        name: 'ShortcutsView',
        template:
            '<section data-testid="shortcuts-view-stub"><div data-settings-search-target="activation-shortcut" /></section>',
    },
}));

vi.mock('@/views/SettingsView/components/AiServices/index.vue', () => ({
    __esModule: true,
    default: {
        name: 'SettingsAiServicesSection',
        setup() {
            const targetVisible = ref(false);
            onMounted(() => {
                sectionMountMocks.aiServices();
                sectionMountMocks.revealAiServicesTarget = () => {
                    targetVisible.value = true;
                };
            });
            return () =>
                h('section', { 'data-testid': 'ai-services-view-stub' }, [
                    targetVisible.value
                        ? h('div', { 'data-settings-search-target': 'models' })
                        : null,
                ]);
        },
    },
}));

vi.mock('@/views/SettingsView/components/BuiltInTools/index.vue', () => ({
    __esModule: true,
    default: {
        name: 'SettingsBuiltInToolsSection',
        setup() {
            onMounted(sectionMountMocks.builtInTools);
            return () => h('section', { 'data-testid': 'built-in-tools-view-stub' });
        },
    },
}));

vi.mock('@/views/SettingsView/components/McpTools/index.vue', () => ({
    __esModule: true,
    default: {
        name: 'McpToolsView',
        template: '<section data-testid="mcp-tools-view-stub" />',
    },
}));

vi.mock('@/views/SettingsView/components/DataManagement/index.vue', () => ({
    __esModule: true,
    default: {
        name: 'DataManagementView',
        template: '<section data-testid="data-management-view-stub" />',
    },
}));

vi.mock('@/views/SettingsView/components/Search/index.vue', () => ({
    __esModule: true,
    default: { name: 'SearchView', template: '<section />' },
}));

vi.mock('@/views/SettingsView/components/Browser/index.vue', () => ({
    __esModule: true,
    default: { name: 'BrowserView', template: '<section />' },
}));

vi.mock('@/views/SettingsView/components/NavigationSidebar.vue', () => ({
    default: {
        name: 'NavigationSidebar',
        props: ['activeSection'],
        emits: ['navigate', 'ready', 'search-select', 'show-update-settings'],
        mounted(this: { $emit: (event: 'ready') => void }) {
            this.$emit('ready');
        },
        template: '<aside data-testid="settings-sidebar-stub" />',
    },
}));

const navigationSidebarStub = {
    name: 'NavigationSidebar',
    props: ['activeSection'],
    emits: ['navigate', 'ready', 'search-select', 'show-update-settings'],
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
                SettingsWindowTitleBar: false,
                KeepAlive: false,
                Suspense: {
                    template: suspenseTemplate,
                },
            },
        },
    });

describe('SettingsWindowView', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        updateServiceMock.checkNow.mockClear();
        updateServiceMock.checkAndOpenUpdates.mockReset().mockResolvedValue(undefined);
        sectionMountMocks.aiServices.mockClear();
        sectionMountMocks.builtInTools.mockClear();
        sectionMountMocks.revealAiServicesTarget = undefined;
        windowApiMock.currentWindow.close.mockClear();
        windowApiMock.currentWindow.isMaximized.mockResolvedValue(false);
        windowApiMock.currentWindow.isMaximized.mockClear();
        windowApiMock.currentWindow.maximize.mockClear();
        windowApiMock.currentWindow.minimize.mockClear();
        windowApiMock.currentWindow.onResized.mockClear();
        windowApiMock.currentWindow.onResized.mockResolvedValue(() => undefined);
        windowApiMock.currentWindow.startDragging.mockClear();
        windowApiMock.currentWindow.unmaximize.mockClear();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('checks for updates each time a settings window mounts', async () => {
        const wrapper = mountSettingsWindow();
        await flushPromises();

        expect(updateServiceMock.checkNow).toHaveBeenCalledWith('settings-open');
        wrapper.unmount();

        const reopened = mountSettingsWindow();
        await flushPromises();
        expect(updateServiceMock.checkNow).toHaveBeenCalledTimes(2);
        reopened.unmount();
    });

    it('checks again when an existing settings window is opened', async () => {
        const wrapper = mountSettingsWindow();
        await flushPromises();
        updateServiceMock.checkNow.mockClear();

        await eventService.emit(AppEvent.SETTINGS_WINDOW_OPENED, null);
        await flushPromises();

        expect(updateServiceMock.checkNow).toHaveBeenCalledWith('settings-open');
        wrapper.unmount();
    });

    it('renders the settings shell immediately without a full-window loading gate', async () => {
        const wrapper = mountSettingsWindow();

        expect(wrapper.find('[data-testid="settings-loading-screen"]').exists()).toBe(false);
        expect(wrapper.get('[data-testid="settings-shell-frame"]').classes()).not.toContain(
            'opacity-0'
        );
        expect(wrapper.find('[data-testid="settings-sidebar-stub"]').exists()).toBe(true);

        await flushPromises();

        expect(wrapper.find('[data-testid="settings-window-header"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="settings-window-title"]').exists()).toBe(false);
        const titleBar = wrapper.get('[data-testid="settings-window-titlebar"]');

        expect(titleBar.attributes()).toHaveProperty('data-tauri-drag-region');
        expect(titleBar.find('[data-testid="settings-window-controls"]').exists()).toBe(true);
        expect(titleBar.element.parentElement).toBe(
            wrapper.get('[data-testid="settings-shell-frame"]').element
        );
        expect(wrapper.find('[data-testid="settings-content-drag-region"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="settings-shell-card"]').exists()).toBe(false);
        expect(wrapper.get('[data-testid="settings-shell-frame"]').classes()).toContain('flex-col');
        expect(wrapper.get('[data-testid="settings-content-shell"]').classes()).toContain('flex-1');
        expect(wrapper.get('[data-testid="settings-content-shell"]').find('button').exists()).toBe(
            false
        );
    });

    it('keeps working custom window controls above the settings content', async () => {
        const wrapper = mountSettingsWindow();

        await vi.runAllTimersAsync();
        await flushPromises();

        expect(wrapper.text()).not.toContain('返回');
        await wrapper.get('[data-testid="settings-window-minimize"]').trigger('click');
        await wrapper.get('[data-testid="settings-window-maximize"]').trigger('click');

        expect(windowApiMock.currentWindow.minimize).toHaveBeenCalledTimes(1);
        expect(windowApiMock.currentWindow.maximize).toHaveBeenCalledTimes(1);
        expect(wrapper.get('[data-testid="settings-window-maximize"]').attributes('title')).toBe(
            '还原'
        );

        windowApiMock.currentWindow.isMaximized.mockResolvedValue(true);
        await wrapper.get('[data-testid="settings-window-maximize"]').trigger('click');
        await wrapper.get('[data-testid="settings-window-close"]').trigger('click');

        expect(windowApiMock.currentWindow.unmaximize).toHaveBeenCalledTimes(1);
        expect(windowApiMock.currentWindow.close).toHaveBeenCalledTimes(1);
    });

    it('keeps content interactions out of the window drag region', async () => {
        const wrapper = mountSettingsWindow();

        await vi.runAllTimersAsync();
        await flushPromises();

        const content = wrapper.get('[data-testid="settings-content-shell"]');

        expect(content.attributes()).not.toHaveProperty('data-tauri-drag-region');

        await content.trigger('mousedown', { button: 0, clientX: 400, clientY: 20 });

        expect(windowApiMock.currentWindow.startDragging).not.toHaveBeenCalled();
    });

    it('does not add an artificial delay before showing settings', async () => {
        const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
        const wrapper = mountSettingsWindow();
        await flushPromises();

        expect(setTimeoutSpy.mock.calls.some(([, delay]) => delay === 180)).toBe(false);
        expect(wrapper.get('[data-testid="settings-shell-frame"]').classes()).not.toContain(
            'opacity-0'
        );

        wrapper.unmount();
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

        nav.vm.$emit('navigate', 'shortcuts');
        await flushPromises();
        expect(loadingState().attributes('message')).toBeUndefined();
        expect(loadingState().attributes('variant')).toBe('brand');

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

        expect(wrapper.findComponent({ name: 'GeneralView' }).exists()).toBe(true);

        nav.vm.$emit('navigate', 'shortcuts');
        await flushPromises();
        expect(wrapper.find('shortcuts-view-stub').exists()).toBe(true);

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

    it('reuses loaded model and built-in tool sections when returning to them', async () => {
        const wrapper = mount(SettingsWindowView, {
            global: { stubs: { NavigationSidebar: navigationSidebarStub } },
        });
        await flushPromises();
        const nav = wrapper.findComponent({ name: 'NavigationSidebar' });

        for (const section of [
            'ai-services',
            'built-in-tools',
            'general',
            'ai-services',
            'built-in-tools',
        ]) {
            nav.vm.$emit('navigate', section);
            await flushPromises();
        }

        expect(sectionMountMocks.aiServices).toHaveBeenCalledTimes(1);
        expect(sectionMountMocks.builtInTools).toHaveBeenCalledTimes(1);
        wrapper.unmount();
    });

    it('scrolls to the update section when the sidebar version is clicked', async () => {
        const scrollIntoView = vi.fn();
        const querySelectorSpy = vi.spyOn(document, 'querySelector').mockReturnValue({
            scrollIntoView,
        } as unknown as Element);
        try {
            const wrapper = mountSettingsWindow();

            await vi.runAllTimersAsync();
            await flushPromises();

            wrapper
                .findComponent({ name: 'NavigationSidebar' })
                .vm.$emit('show-update-settings', { checkAndOpen: true });
            await flushPromises();
            await vi.runOnlyPendingTimersAsync();

            expect(querySelectorSpy).toHaveBeenCalledWith('[data-settings-update-section="true"]');
            expect(scrollIntoView).toHaveBeenCalledWith({
                block: 'start',
                behavior: 'smooth',
            });
        } finally {
            querySelectorSpy.mockRestore();
        }
    });

    it('navigates and scrolls immediately while the version-badge check is pending', async () => {
        let finishCheck!: () => void;
        updateServiceMock.checkAndOpenUpdates.mockReturnValueOnce(
            new Promise<void>((resolve) => {
                finishCheck = resolve;
            })
        );
        const scrollIntoView = vi.fn();
        const querySelectorSpy = vi.spyOn(document, 'querySelector').mockReturnValue({
            scrollIntoView,
        } as unknown as Element);
        const wrapper = mount(SettingsWindowView, {
            global: { stubs: { NavigationSidebar: navigationSidebarStub } },
        });

        try {
            await flushPromises();
            const sidebar = wrapper.findComponent({ name: 'NavigationSidebar' });
            sidebar.vm.$emit('navigate', 'shortcuts');
            await flushPromises();

            sidebar.vm.$emit('show-update-settings', { checkAndOpen: true });
            await flushPromises();
            await vi.runOnlyPendingTimersAsync();

            expect(wrapper.findComponent({ name: 'GeneralView' }).exists()).toBe(true);
            expect(updateServiceMock.checkAndOpenUpdates).toHaveBeenCalledTimes(1);
            expect(scrollIntoView).toHaveBeenCalledWith({
                block: 'start',
                behavior: 'smooth',
            });
        } finally {
            finishCheck();
            await flushPromises();
            wrapper.unmount();
            querySelectorSpy.mockRestore();
        }
    });

    it('waits for a first-load lazy section before scrolling to its search result', async () => {
        const scrollIntoView = vi.fn();
        const originalScrollIntoView = Element.prototype.scrollIntoView;
        Element.prototype.scrollIntoView = scrollIntoView;
        const wrapper = mount(SettingsWindowView, {
            attachTo: document.body,
            global: { stubs: { NavigationSidebar: navigationSidebarStub } },
        });

        try {
            wrapper.findComponent({ name: 'NavigationSidebar' }).vm.$emit('search-select', {
                id: 'shortcuts:activation-shortcut',
                section: 'shortcuts',
                targetId: 'activation-shortcut',
            });
            await flushPromises();

            expect(
                wrapper.find('[data-settings-search-target="activation-shortcut"]').exists()
            ).toBe(true);
            expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
            expect(scrollIntoView.mock.contexts[scrollIntoView.mock.contexts.length - 1]).toBe(
                wrapper.get('[data-settings-search-target="activation-shortcut"]').element
            );
        } finally {
            wrapper.unmount();
            Element.prototype.scrollIntoView = originalScrollIntoView;
        }
    });

    it('waits for a model target rendered after the section resolves', async () => {
        const scrollIntoView = vi.fn();
        const originalScrollIntoView = Element.prototype.scrollIntoView;
        Element.prototype.scrollIntoView = scrollIntoView;
        const wrapper = mount(SettingsWindowView, {
            attachTo: document.body,
            global: { stubs: { NavigationSidebar: navigationSidebarStub } },
        });

        try {
            wrapper.findComponent({ name: 'NavigationSidebar' }).vm.$emit('search-select', {
                id: 'ai-services:models',
                section: 'ai-services',
                targetId: 'models',
            });
            await flushPromises();
            expect(wrapper.find('[data-settings-search-target="models"]').exists()).toBe(false);
            expect(scrollIntoView).not.toHaveBeenCalled();

            sectionMountMocks.revealAiServicesTarget?.();
            await flushPromises();
            expect(scrollIntoView).toHaveBeenCalledOnce();
            expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
            expect(scrollIntoView.mock.contexts[0]).toBe(
                wrapper.get('[data-settings-search-target="models"]').element
            );
        } finally {
            wrapper.unmount();
            Element.prototype.scrollIntoView = originalScrollIntoView;
        }
    });

    it('falls back to the section top when its search target never appears', async () => {
        const scrollIntoView = vi.fn();
        const originalScrollIntoView = Element.prototype.scrollIntoView;
        Element.prototype.scrollIntoView = scrollIntoView;
        const wrapper = mount(SettingsWindowView, {
            attachTo: document.body,
            global: { stubs: { NavigationSidebar: navigationSidebarStub } },
        });

        try {
            wrapper.findComponent({ name: 'NavigationSidebar' }).vm.$emit('search-select', {
                id: 'ai-services:models',
                section: 'ai-services',
                targetId: 'models',
            });
            await flushPromises();
            expect(scrollIntoView).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(5000);
            expect(scrollIntoView).toHaveBeenCalledOnce();
            expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' });

            sectionMountMocks.revealAiServicesTarget?.();
            await flushPromises();
            expect(scrollIntoView).toHaveBeenCalledOnce();
        } finally {
            wrapper.unmount();
            Element.prototype.scrollIntoView = originalScrollIntoView;
        }
    });

    it('cancels pending search scrolling after navigating to another section', async () => {
        const scrollIntoView = vi.fn();
        const originalScrollIntoView = Element.prototype.scrollIntoView;
        Element.prototype.scrollIntoView = scrollIntoView;
        const wrapper = mount(SettingsWindowView, {
            attachTo: document.body,
            global: { stubs: { NavigationSidebar: navigationSidebarStub } },
        });

        try {
            const sidebar = wrapper.findComponent({ name: 'NavigationSidebar' });
            sidebar.vm.$emit('search-select', {
                id: 'ai-services:models',
                section: 'ai-services',
                targetId: 'models',
            });
            await flushPromises();
            sidebar.vm.$emit('navigate', 'general');
            await flushPromises();

            sectionMountMocks.revealAiServicesTarget?.();
            await flushPromises();
            await vi.advanceTimersByTimeAsync(5000);
            expect(scrollIntoView).not.toHaveBeenCalled();
        } finally {
            wrapper.unmount();
            Element.prototype.scrollIntoView = originalScrollIntoView;
        }
    });

    it('scrolls to the update section when the general page update badge is clicked', async () => {
        const scrollIntoView = vi.fn();
        const querySelectorSpy = vi.spyOn(document, 'querySelector').mockReturnValue({
            scrollIntoView,
        } as unknown as Element);
        const wrapper = mount(SettingsWindowView, {
            global: { stubs: { NavigationSidebar: navigationSidebarStub } },
        });

        try {
            await flushPromises();
            wrapper.findComponent({ name: 'GeneralView' }).vm.$emit('show-update-settings');
            await flushPromises();
            await vi.runOnlyPendingTimersAsync();

            expect(scrollIntoView).toHaveBeenCalledWith({
                block: 'start',
                behavior: 'smooth',
            });
        } finally {
            wrapper.unmount();
            querySelectorSpy.mockRestore();
        }
    });
});
