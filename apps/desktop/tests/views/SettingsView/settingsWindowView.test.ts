import { flushPromises, shallowMount } from '@vue/test-utils';
import { afterEach, beforeEach, vi } from 'vitest';

import SettingsWindowView from '@/views/SettingsView/index.vue';

const windowApiMock = vi.hoisted(() => ({
    currentWindow: {
        close: vi.fn().mockResolvedValue(undefined),
        isMaximized: vi.fn().mockResolvedValue(false),
        maximize: vi.fn().mockResolvedValue(undefined),
        minimize: vi.fn().mockResolvedValue(undefined),
        startDragging: vi.fn().mockResolvedValue(undefined),
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
        emits: ['navigate', 'ready', 'show-update-settings'],
        mounted(this: { $emit: (event: 'ready') => void }) {
            this.$emit('ready');
        },
        template: '<aside data-testid="settings-sidebar-stub" />',
    },
}));

const navigationSidebarStub = {
    name: 'NavigationSidebar',
    props: ['activeSection'],
    emits: ['navigate', 'ready', 'show-update-settings'],
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
        windowApiMock.currentWindow.startDragging.mockClear();
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
        expect(wrapper.get('[data-testid="settings-content-shell"]').classes()).toContain(
            'relative'
        );
        expect(wrapper.get('[data-testid="settings-content-shell"]').classes()).toContain('z-20');
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

    async function mountReadySettingsWindow() {
        const wrapper = mountSettingsWindow();
        await vi.runAllTimersAsync();
        await flushPromises();
        vi.spyOn(
            wrapper.get('[data-testid="settings-content-drag-region"]').element,
            'getBoundingClientRect'
        ).mockReturnValue({
            left: 200,
            top: 100,
            right: 1000,
            bottom: 136,
        } as DOMRect);
        return wrapper;
    }

    it('starts native dragging from the top blank area even when content covers the drag layer', async () => {
        const wrapper = await mountReadySettingsWindow();
        const title = document.createElement('span');
        title.textContent = 'Section title';
        wrapper.get('[data-testid="settings-content-shell"]').element.append(title);

        title.dispatchEvent(
            new MouseEvent('mousedown', {
                bubbles: true,
                cancelable: true,
                button: 0,
                clientX: 400,
                clientY: 112,
            })
        );
        await flushPromises();

        expect(windowApiMock.currentWindow.startDragging).toHaveBeenCalledTimes(1);
    });

    it.each([
        { clientX: 400, clientY: 160 },
        { clientX: 400, clientY: 99 },
        { clientX: 400, clientY: 136 },
        { clientX: 199, clientY: 112 },
        { clientX: 1000, clientY: 112 },
    ])('does not drag from outside the top drag band: %o', async (position) => {
        const wrapper = await mountReadySettingsWindow();
        await wrapper.get('[data-testid="settings-content-shell"]').trigger('mousedown', {
            button: 0,
            ...position,
        });
        expect(windowApiMock.currentWindow.startDragging).not.toHaveBeenCalled();
    });

    it.each([1, 2])('does not drag on mouse button %s', async (button) => {
        const wrapper = await mountReadySettingsWindow();
        await wrapper.get('[data-testid="settings-content-shell"]').trigger('mousedown', {
            button,
            clientX: 400,
            clientY: 112,
        });
        expect(windowApiMock.currentWindow.startDragging).not.toHaveBeenCalled();
    });

    it.each([
        '<button><span>Tab label</span></button>',
        '<a href="#"><span>Link</span></a>',
        '<input />',
        '<textarea></textarea>',
        '<select><option>Option</option></select>',
        '<label><span>Toggle label</span></label>',
        '<div role="tab"><span>Tab label</span></div>',
        '<div role="separator"><span>Resize handle</span></div>',
        '<div tabindex="0"><span>Focusable item</span></div>',
        '<div contenteditable="true"><span>Editable content</span></div>',
        '<div data-tauri-drag-region="false"><span>No-drag content</span></div>',
        '<div data-drag-exclude="true"><span>Excluded content</span></div>',
        '<div class="cursor-pointer"><span>Provider or tool card</span></div>',
    ])('keeps top-area controls clickable without starting a window drag: %s', async (markup) => {
        const wrapper = await mountReadySettingsWindow();
        const host = document.createElement('div');
        host.innerHTML = markup;
        const control = host.firstElementChild!;
        wrapper.get('[data-testid="settings-content-shell"]').element.append(control);
        const target = control.querySelector('span') ?? control;
        const onClick = vi.fn();
        control.addEventListener('click', onClick);
        const mouseDown = new MouseEvent('mousedown', {
            bubbles: true,
            cancelable: true,
            button: 0,
            clientX: 400,
            clientY: 112,
        });

        target.dispatchEvent(mouseDown);
        target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await flushPromises();

        expect(windowApiMock.currentWindow.startDragging).not.toHaveBeenCalled();
        expect(mouseDown.defaultPrevented).toBe(false);
        expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('respects a child consuming the mousedown event', async () => {
        const wrapper = await mountReadySettingsWindow();
        const child = document.createElement('div');
        child.addEventListener('mousedown', (event) => event.preventDefault());
        wrapper.get('[data-testid="settings-content-shell"]').element.append(child);
        child.dispatchEvent(
            new MouseEvent('mousedown', {
                bubbles: true,
                cancelable: true,
                button: 0,
                clientX: 400,
                clientY: 112,
            })
        );
        await flushPromises();
        expect(windowApiMock.currentWindow.startDragging).not.toHaveBeenCalled();
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
        expect(loadingState().attributes('message')).toBe('正在加载常规设置...');

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

    it('scrolls to the update section when the sidebar version is clicked', async () => {
        const scrollIntoView = vi.fn();
        const querySelectorSpy = vi.spyOn(document, 'querySelector').mockReturnValue({
            scrollIntoView,
        } as unknown as Element);
        try {
            const wrapper = mountSettingsWindow();

            await vi.runAllTimersAsync();
            await flushPromises();

            wrapper.findComponent({ name: 'NavigationSidebar' }).vm.$emit('show-update-settings');
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
});
