import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, vi } from 'vitest';

import NavigationSidebar from '@/views/SettingsView/components/NavigationSidebar.vue';
import {
    SETTINGS_DETAIL_PANEL_MIN_WIDTH,
    SETTINGS_LAYOUT_MIN_WIDTH,
    SETTINGS_SECONDARY_SIDEBAR_DEFAULT_WIDTH,
    SETTINGS_SIDEBAR_DEFAULT_WIDTH,
    SETTINGS_SIDEBAR_MAX_WIDTH,
    SETTINGS_SIDEBAR_MIN_WIDTH,
} from '@/views/SettingsView/settingsSidebarLayout';

const openUrlMock = vi.hoisted(() => vi.fn());

vi.mock('@components/AppIcon.vue', () => ({
    default: {
        name: 'AppIconStub',
        props: ['name'],
        template: '<span data-testid="app-icon" :data-name="name" />',
    },
}));

vi.mock('@tauri-apps/plugin-opener', () => ({
    openUrl: openUrlMock,
}));

function createPointerEvent(type: string, clientX: number, pointerId = 11) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'button', { value: 0 });
    Object.defineProperty(event, 'clientX', { value: clientX });
    Object.defineProperty(event, 'pointerId', { value: pointerId });
    return event;
}

describe('NavigationSidebar', () => {
    let originalInnerWidth: number;

    beforeEach(() => {
        originalInnerWidth = window.innerWidth;
        openUrlMock.mockReset();
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
    });

    afterEach(() => {
        Object.defineProperty(window, 'innerWidth', {
            configurable: true,
            value: originalInnerWidth,
        });
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
    });

    it('renders compact system-style navigation without a back button, overview page, or group descriptions', () => {
        const wrapper = mount(NavigationSidebar, {
            props: {
                activeSection: 'general',
            },
        });

        expect(wrapper.text()).not.toContain('返回');
        expect(wrapper.text()).not.toContain('概览');
        expect(wrapper.text()).toContain('通用');
        expect(wrapper.text()).toContain('服务商与模型');
        expect(wrapper.text()).not.toContain('关于');
        expect(wrapper.text()).not.toContain('Provider、模型、默认模型和密钥');
    });

    it('keeps version and external links at the sidebar bottom', async () => {
        const wrapper = mount(NavigationSidebar, {
            props: {
                activeSection: 'general',
            },
        });

        expect(wrapper.text()).toContain('TouchAI v0.1.0');
        expect(wrapper.find('[data-testid="settings-sidebar-github"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="settings-sidebar-issues"]').exists()).toBe(true);

        await wrapper.get('[data-testid="settings-sidebar-github"]').trigger('click');
        await wrapper.get('[data-testid="settings-sidebar-issues"]').trigger('click');

        expect(openUrlMock).toHaveBeenNthCalledWith(1, 'https://github.com/TouchAI-org/TouchAI');
        expect(openUrlMock).toHaveBeenNthCalledWith(
            2,
            'https://github.com/TouchAI-org/TouchAI/issues'
        );
    });

    it('handles external link opener failures without throwing', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        openUrlMock.mockRejectedValueOnce(new Error('opener unavailable'));
        const wrapper = mount(NavigationSidebar, {
            props: {
                activeSection: 'general',
            },
        });

        await wrapper.get('[data-testid="settings-sidebar-github"]').trigger('click');

        expect(warnSpy).toHaveBeenCalledWith(
            '[SettingsSidebar] Failed to open external link:',
            'https://github.com/TouchAI-org/TouchAI',
            expect.any(Error)
        );
        warnSpy.mockRestore();
    });

    it('emits navigation requests when a section is clicked', async () => {
        const wrapper = mount(NavigationSidebar, {
            props: {
                activeSection: 'general',
            },
        });

        await wrapper.get('[data-testid="settings-nav-general"]').trigger('click');

        expect(wrapper.emitted('navigate')?.[0]).toEqual(['general']);
    });

    it('lets users drag the sidebar width while respecting minimum and maximum bounds', async () => {
        const wrapper = mount(NavigationSidebar, {
            props: {
                activeSection: 'general',
            },
        });

        const sidebar = wrapper.get('[data-testid="settings-sidebar"]');
        const resizer = wrapper.get('[data-testid="settings-sidebar-resizer"]');

        const createPointerEvent = (type: string, clientX: number, pointerId = 11) => {
            const event = new Event(type, { bubbles: true, cancelable: true });
            Object.defineProperty(event, 'button', { value: 0 });
            Object.defineProperty(event, 'clientX', { value: clientX });
            Object.defineProperty(event, 'pointerId', { value: pointerId });
            return event;
        };

        resizer.element.dispatchEvent(createPointerEvent('pointerdown', 240));
        await wrapper.vm.$nextTick();
        window.dispatchEvent(createPointerEvent('pointermove', 320));
        await wrapper.vm.$nextTick();

        expect(sidebar.attributes('style')).toContain(
            `width: ${SETTINGS_SIDEBAR_DEFAULT_WIDTH + 80}px`
        );

        window.dispatchEvent(createPointerEvent('pointermove', -200));
        await wrapper.vm.$nextTick();

        expect(sidebar.attributes('style')).toContain(`width: ${SETTINGS_SIDEBAR_MIN_WIDTH}px`);

        window.dispatchEvent(createPointerEvent('pointermove', 800));
        await wrapper.vm.$nextTick();

        expect(sidebar.attributes('style')).toContain(`width: ${SETTINGS_SIDEBAR_MAX_WIDTH}px`);

        window.dispatchEvent(createPointerEvent('pointerup', 800));
        await wrapper.vm.$nextTick();

        expect(document.body.style.cursor).toBe('');
        expect(document.body.style.userSelect).toBe('');
    });

    it('captures pointer and restores previous body styles when dragging is lost', async () => {
        const wrapper = mount(NavigationSidebar, {
            props: {
                activeSection: 'general',
            },
        });

        document.body.style.cursor = 'crosshair';
        document.body.style.userSelect = 'text';

        const resizerElement = wrapper.get('[data-testid="settings-sidebar-resizer"]')
            .element as HTMLElement & {
            releasePointerCapture: (pointerId: number) => void;
            setPointerCapture: (pointerId: number) => void;
        };
        const setPointerCaptureMock = vi.fn<(pointerId: number) => void>();
        const releasePointerCaptureMock = vi.fn<(pointerId: number) => void>();
        resizerElement.setPointerCapture = setPointerCaptureMock;
        resizerElement.releasePointerCapture = releasePointerCaptureMock;

        const createPointerEvent = (type: string, clientX: number, pointerId = 42) => {
            const event = new Event(type, { bubbles: true, cancelable: true });
            Object.defineProperty(event, 'button', { value: 0 });
            Object.defineProperty(event, 'clientX', { value: clientX });
            Object.defineProperty(event, 'pointerId', { value: pointerId });
            return event;
        };

        resizerElement.dispatchEvent(createPointerEvent('pointerdown', 240));
        await wrapper.vm.$nextTick();

        expect(setPointerCaptureMock).toHaveBeenCalledWith(42);
        expect(document.body.style.cursor).toBe('col-resize');
        expect(document.body.style.userSelect).toBe('none');

        resizerElement.dispatchEvent(createPointerEvent('lostpointercapture', 240));
        await wrapper.vm.$nextTick();

        expect(releasePointerCaptureMock).toHaveBeenCalledWith(42);
        expect(document.body.style.cursor).toBe('crosshair');
        expect(document.body.style.userSelect).toBe('text');
    });

    it('ignores unrelated resize pointers and handles window-level cancellation', async () => {
        const wrapper = mount(NavigationSidebar, {
            props: {
                activeSection: 'general',
            },
        });

        document.body.style.cursor = 'crosshair';
        document.body.style.userSelect = 'text';

        const sidebar = wrapper.get('[data-testid="settings-sidebar"]');
        const resizerElement = wrapper.get('[data-testid="settings-sidebar-resizer"]')
            .element as HTMLElement & {
            releasePointerCapture: (pointerId: number) => void;
            setPointerCapture: (pointerId: number) => void;
        };
        const setPointerCaptureMock = vi.fn<(pointerId: number) => void>(() => {
            throw new Error('capture unavailable');
        });
        const releasePointerCaptureMock = vi.fn<(pointerId: number) => void>();
        resizerElement.setPointerCapture = setPointerCaptureMock;
        resizerElement.releasePointerCapture = releasePointerCaptureMock;

        const createPointerEvent = (type: string, clientX: number, pointerId = 42) => {
            const event = new Event(type, { bubbles: true, cancelable: true });
            Object.defineProperty(event, 'button', { value: 0 });
            Object.defineProperty(event, 'clientX', { value: clientX });
            Object.defineProperty(event, 'pointerId', { value: pointerId });
            return event;
        };

        resizerElement.dispatchEvent(createPointerEvent('pointerdown', 240, 42));
        await wrapper.vm.$nextTick();

        window.dispatchEvent(createPointerEvent('pointermove', 320, 99));
        await wrapper.vm.$nextTick();

        expect(sidebar.attributes('style')).toContain(`width: ${SETTINGS_SIDEBAR_DEFAULT_WIDTH}px`);

        window.dispatchEvent(createPointerEvent('pointercancel', 320, 42));
        await wrapper.vm.$nextTick();

        expect(document.body.style.cursor).toBe('crosshair');
        expect(document.body.style.userSelect).toBe('text');
    });

    it('ignores overlapping pointerdown events while a sidebar resize is active', async () => {
        const wrapper = mount(NavigationSidebar, {
            props: {
                activeSection: 'general',
            },
        });

        document.body.style.cursor = 'crosshair';
        document.body.style.userSelect = 'text';

        const resizerElement = wrapper.get('[data-testid="settings-sidebar-resizer"]')
            .element as HTMLElement & {
            releasePointerCapture: (pointerId: number) => void;
            setPointerCapture: (pointerId: number) => void;
        };
        const setPointerCaptureMock = vi.fn<(pointerId: number) => void>();
        const releasePointerCaptureMock = vi.fn<(pointerId: number) => void>();
        resizerElement.setPointerCapture = setPointerCaptureMock;
        resizerElement.releasePointerCapture = releasePointerCaptureMock;

        const createPointerEvent = (type: string, clientX: number, pointerId = 42) => {
            const event = new Event(type, { bubbles: true, cancelable: true });
            Object.defineProperty(event, 'button', { value: 0 });
            Object.defineProperty(event, 'clientX', { value: clientX });
            Object.defineProperty(event, 'pointerId', { value: pointerId });
            return event;
        };

        resizerElement.dispatchEvent(createPointerEvent('pointerdown', 240, 42));
        resizerElement.dispatchEvent(createPointerEvent('pointerdown', 260, 43));
        window.dispatchEvent(createPointerEvent('pointercancel', 260, 42));
        await wrapper.vm.$nextTick();

        expect(document.body.style.cursor).toBe('crosshair');
        expect(document.body.style.userSelect).toBe('text');
    });

    it('ignores non-primary pointerdown events for the sidebar resize handle', async () => {
        const wrapper = mount(NavigationSidebar, {
            props: {
                activeSection: 'general',
            },
        });

        const sidebar = wrapper.get('[data-testid="settings-sidebar"]');
        const resizerElement = wrapper.get('[data-testid="settings-sidebar-resizer"]').element;
        const pointerDown = new Event('pointerdown', { bubbles: true, cancelable: true });
        Object.defineProperty(pointerDown, 'button', { value: 1 });
        Object.defineProperty(pointerDown, 'clientX', { value: 240 });
        Object.defineProperty(pointerDown, 'pointerId', { value: 42 });

        resizerElement.dispatchEvent(pointerDown);
        window.dispatchEvent(createPointerEvent('pointermove', 320, 42));
        await wrapper.vm.$nextTick();

        expect(sidebar.attributes('style')).toContain(`width: ${SETTINGS_SIDEBAR_DEFAULT_WIDTH}px`);
        expect(document.body.style.cursor).toBe('');
        expect(document.body.style.userSelect).toBe('');
    });

    it('restores body styles when unmounted during sidebar resize', async () => {
        const wrapper = mount(NavigationSidebar, {
            props: {
                activeSection: 'general',
            },
        });

        document.body.style.cursor = 'crosshair';
        document.body.style.userSelect = 'text';

        wrapper
            .get('[data-testid="settings-sidebar-resizer"]')
            .element.dispatchEvent(createPointerEvent('pointerdown', 240, 42));
        await wrapper.vm.$nextTick();

        wrapper.unmount();

        expect(document.body.style.cursor).toBe('crosshair');
        expect(document.body.style.userSelect).toBe('text');
    });

    it('reclamps the sidebar when entering a three-column settings page at the minimum width', async () => {
        Object.defineProperty(window, 'innerWidth', {
            configurable: true,
            value: SETTINGS_LAYOUT_MIN_WIDTH,
        });

        const wrapper = mount(NavigationSidebar, {
            props: {
                activeSection: 'general',
            },
        });

        const sidebar = wrapper.get('[data-testid="settings-sidebar"]');
        const resizer = wrapper.get('[data-testid="settings-sidebar-resizer"]');

        const createPointerEvent = (type: string, clientX: number, pointerId = 42) => {
            const event = new Event(type, { bubbles: true, cancelable: true });
            Object.defineProperty(event, 'button', { value: 0 });
            Object.defineProperty(event, 'clientX', { value: clientX });
            Object.defineProperty(event, 'pointerId', { value: pointerId });
            return event;
        };

        resizer.element.dispatchEvent(createPointerEvent('pointerdown', 240));
        window.dispatchEvent(createPointerEvent('pointermove', 500));
        window.dispatchEvent(createPointerEvent('pointerup', 500));
        await wrapper.vm.$nextTick();

        expect(sidebar.attributes('style')).toContain(`width: ${SETTINGS_SIDEBAR_MAX_WIDTH}px`);

        await wrapper.setProps({ activeSection: 'ai-services' });
        await wrapper.vm.$nextTick();

        const effectiveMax = Math.max(
            SETTINGS_SIDEBAR_MIN_WIDTH,
            SETTINGS_LAYOUT_MIN_WIDTH -
                SETTINGS_SECONDARY_SIDEBAR_DEFAULT_WIDTH -
                SETTINGS_DETAIL_PANEL_MIN_WIDTH
        );

        expect(sidebar.attributes('style')).toContain(`width: ${effectiveMax}px`);
        expect(resizer.attributes('aria-valuemax')).toBe(String(effectiveMax));
    });

    it('supports keyboard resizing from the sidebar separator', async () => {
        const wrapper = mount(NavigationSidebar, {
            props: {
                activeSection: 'general',
            },
        });

        const sidebar = wrapper.get('[data-testid="settings-sidebar"]');
        const resizer = wrapper.get('[data-testid="settings-sidebar-resizer"]');

        expect(resizer.attributes('tabindex')).toBe('0');

        await resizer.trigger('keydown', { key: 'Tab' });
        expect(sidebar.attributes('style')).toContain(`width: ${SETTINGS_SIDEBAR_DEFAULT_WIDTH}px`);

        await resizer.trigger('keydown', { key: 'ArrowRight' });
        expect(sidebar.attributes('style')).toContain(
            `width: ${SETTINGS_SIDEBAR_DEFAULT_WIDTH + 16}px`
        );

        await resizer.trigger('keydown', { key: 'End' });
        expect(sidebar.attributes('style')).toContain(`width: ${SETTINGS_SIDEBAR_MAX_WIDTH}px`);

        await resizer.trigger('keydown', { key: 'Home' });
        expect(sidebar.attributes('style')).toContain(`width: ${SETTINGS_SIDEBAR_MIN_WIDTH}px`);

        await resizer.trigger('keydown', { key: 'ArrowLeft' });
        expect(sidebar.attributes('style')).toContain(`width: ${SETTINGS_SIDEBAR_MIN_WIDTH}px`);
    });
});
