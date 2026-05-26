import { mount } from '@vue/test-utils';
import { vi } from 'vitest';
import { defineComponent } from 'vue';

import { useSettingsResizablePanel } from '@/views/SettingsView/composables/useSettingsResizablePanel';
import {
    SETTINGS_DETAIL_PANEL_MIN_WIDTH,
    SETTINGS_LAYOUT_MIN_WIDTH,
    SETTINGS_RESIZE_KEYBOARD_STEP,
    SETTINGS_SECONDARY_SIDEBAR_DEFAULT_WIDTH,
    SETTINGS_SECONDARY_SIDEBAR_MAX_WIDTH,
    SETTINGS_SECONDARY_SIDEBAR_MIN_WIDTH,
    SETTINGS_SIDEBAR_MIN_WIDTH,
} from '@/views/SettingsView/settingsSidebarLayout';

const ResizablePanelHarness = defineComponent({
    name: 'ResizablePanelHarness',
    setup() {
        return useSettingsResizablePanel();
    },
    template: `
        <aside data-testid="panel" :style="panelStyle">
            <button
                data-testid="resizer"
                @keydown="handleResizeKeyDown"
                @pointerdown="handleResizePointerDown"
            />
        </aside>
    `,
});

function createPointerEvent(type: string, clientX: number, pointerId = 11, button = 0) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'button', { value: button });
    Object.defineProperty(event, 'clientX', { value: clientX });
    Object.defineProperty(event, 'pointerId', { value: pointerId });
    return event;
}

describe('useSettingsResizablePanel', () => {
    let originalInnerWidth: number;

    beforeEach(() => {
        originalInnerWidth = window.innerWidth;
    });

    afterEach(() => {
        Object.defineProperty(window, 'innerWidth', {
            configurable: true,
            value: originalInnerWidth,
        });
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.querySelector('[data-testid="settings-sidebar"]')?.remove();
    });

    it('drags secondary panel width while respecting bounds and cleanup', async () => {
        const wrapper = mount(ResizablePanelHarness);

        const panel = wrapper.get('[data-testid="panel"]');
        const resizer = wrapper.get('[data-testid="resizer"]');

        resizer.element.dispatchEvent(createPointerEvent('pointerdown', 230));
        await wrapper.vm.$nextTick();
        window.dispatchEvent(createPointerEvent('pointermove', 282));
        await wrapper.vm.$nextTick();

        expect(panel.attributes('style')).toContain(
            `width: ${SETTINGS_SECONDARY_SIDEBAR_DEFAULT_WIDTH + 52}px`
        );

        window.dispatchEvent(createPointerEvent('pointermove', -100));
        await wrapper.vm.$nextTick();

        expect(panel.attributes('style')).toContain(
            `width: ${SETTINGS_SECONDARY_SIDEBAR_MIN_WIDTH}px`
        );

        window.dispatchEvent(createPointerEvent('pointermove', 800));
        await wrapper.vm.$nextTick();

        expect(panel.attributes('style')).toContain(
            `width: ${SETTINGS_SECONDARY_SIDEBAR_MAX_WIDTH}px`
        );

        window.dispatchEvent(createPointerEvent('pointerup', 800));
        await wrapper.vm.$nextTick();

        expect(document.body.style.cursor).toBe('');
        expect(document.body.style.userSelect).toBe('');
    });

    it('uses pointer capture and restores previous body styles when dragging is cancelled', async () => {
        const wrapper = mount(ResizablePanelHarness);

        document.body.style.cursor = 'crosshair';
        document.body.style.userSelect = 'text';

        const resizerElement = wrapper.get('[data-testid="resizer"]').element as HTMLElement & {
            releasePointerCapture: (pointerId: number) => void;
            setPointerCapture: (pointerId: number) => void;
        };
        const setPointerCaptureMock = vi.fn<(pointerId: number) => void>();
        const releasePointerCaptureMock = vi.fn<(pointerId: number) => void>();
        resizerElement.setPointerCapture = setPointerCaptureMock;
        resizerElement.releasePointerCapture = releasePointerCaptureMock;

        resizerElement.dispatchEvent(createPointerEvent('pointerdown', 230, 42));
        await wrapper.vm.$nextTick();

        expect(setPointerCaptureMock).toHaveBeenCalledWith(42);
        expect(document.body.style.cursor).toBe('col-resize');
        expect(document.body.style.userSelect).toBe('none');

        resizerElement.dispatchEvent(createPointerEvent('pointercancel', 230, 42));
        await wrapper.vm.$nextTick();

        expect(releasePointerCaptureMock).toHaveBeenCalledWith(42);
        expect(document.body.style.cursor).toBe('crosshair');
        expect(document.body.style.userSelect).toBe('text');
    });

    it('ignores unrelated pointers and cleans up when the window cancels dragging', async () => {
        const wrapper = mount(ResizablePanelHarness);

        document.body.style.cursor = 'crosshair';
        document.body.style.userSelect = 'text';

        const panel = wrapper.get('[data-testid="panel"]');
        const resizerElement = wrapper.get('[data-testid="resizer"]').element as HTMLElement & {
            releasePointerCapture: (pointerId: number) => void;
            setPointerCapture: (pointerId: number) => void;
        };
        const setPointerCaptureMock = vi.fn<(pointerId: number) => void>(() => {
            throw new Error('capture unavailable');
        });
        const releasePointerCaptureMock = vi.fn<(pointerId: number) => void>();
        resizerElement.setPointerCapture = setPointerCaptureMock;
        resizerElement.releasePointerCapture = releasePointerCaptureMock;

        resizerElement.dispatchEvent(createPointerEvent('pointerdown', 230, 42));
        await wrapper.vm.$nextTick();

        window.dispatchEvent(createPointerEvent('pointermove', 362, 99));
        await wrapper.vm.$nextTick();

        expect(panel.attributes('style')).toContain(
            `width: ${SETTINGS_SECONDARY_SIDEBAR_DEFAULT_WIDTH}px`
        );

        window.dispatchEvent(createPointerEvent('pointercancel', 362, 42));
        await wrapper.vm.$nextTick();

        expect(document.body.style.cursor).toBe('crosshair');
        expect(document.body.style.userSelect).toBe('text');
    });

    it('ignores overlapping pointerdown events while a secondary resize is active', async () => {
        const wrapper = mount(ResizablePanelHarness);

        document.body.style.cursor = 'crosshair';
        document.body.style.userSelect = 'text';

        const resizerElement = wrapper.get('[data-testid="resizer"]').element as HTMLElement & {
            releasePointerCapture: (pointerId: number) => void;
            setPointerCapture: (pointerId: number) => void;
        };
        const setPointerCaptureMock = vi.fn<(pointerId: number) => void>();
        const releasePointerCaptureMock = vi.fn<(pointerId: number) => void>();
        resizerElement.setPointerCapture = setPointerCaptureMock;
        resizerElement.releasePointerCapture = releasePointerCaptureMock;

        resizerElement.dispatchEvent(createPointerEvent('pointerdown', 230, 42));
        resizerElement.dispatchEvent(createPointerEvent('pointerdown', 246, 43));
        window.dispatchEvent(createPointerEvent('pointercancel', 246, 42));
        await wrapper.vm.$nextTick();

        expect(document.body.style.cursor).toBe('crosshair');
        expect(document.body.style.userSelect).toBe('text');
    });

    it('ignores non-primary pointerdown events for secondary resize handles', async () => {
        const wrapper = mount(ResizablePanelHarness);
        const panel = wrapper.get('[data-testid="panel"]');
        const resizerElement = wrapper.get('[data-testid="resizer"]').element;

        resizerElement.dispatchEvent(createPointerEvent('pointerdown', 230, 42, 1));
        window.dispatchEvent(createPointerEvent('pointermove', 330, 42));
        await wrapper.vm.$nextTick();

        expect(panel.attributes('style')).toContain(
            `width: ${SETTINGS_SECONDARY_SIDEBAR_DEFAULT_WIDTH}px`
        );
        expect(document.body.style.cursor).toBe('');
        expect(document.body.style.userSelect).toBe('');
    });

    it('restores body styles when unmounted during a secondary resize', async () => {
        const wrapper = mount(ResizablePanelHarness);

        document.body.style.cursor = 'crosshair';
        document.body.style.userSelect = 'text';

        wrapper
            .get('[data-testid="resizer"]')
            .element.dispatchEvent(createPointerEvent('pointerdown', 230, 42));
        await wrapper.vm.$nextTick();

        wrapper.unmount();

        expect(document.body.style.cursor).toBe('crosshair');
        expect(document.body.style.userSelect).toBe('text');
    });

    it('exposes the current effective max width for secondary panel separators', async () => {
        Object.defineProperty(window, 'innerWidth', {
            configurable: true,
            value: SETTINGS_LAYOUT_MIN_WIDTH,
        });

        const sidebar = document.createElement('aside');
        sidebar.dataset.testid = 'settings-sidebar';
        sidebar.style.width = `${SETTINGS_SIDEBAR_MIN_WIDTH}px`;
        document.body.appendChild(sidebar);

        const wrapper = mount(ResizablePanelHarness);
        await wrapper.vm.$nextTick();

        const effectiveMax =
            SETTINGS_LAYOUT_MIN_WIDTH -
            SETTINGS_SIDEBAR_MIN_WIDTH -
            SETTINGS_DETAIL_PANEL_MIN_WIDTH;

        expect(wrapper.vm.panelMaxWidth).toBe(
            Math.min(SETTINGS_SECONDARY_SIDEBAR_MAX_WIDTH, effectiveMax)
        );
    });

    it('supports keyboard resizing for secondary panels', async () => {
        const wrapper = mount(ResizablePanelHarness);
        const panel = wrapper.get('[data-testid="panel"]');
        const resizer = wrapper.get('[data-testid="resizer"]');

        await resizer.trigger('keydown', { key: 'Tab' });
        expect(panel.attributes('style')).toContain(
            `width: ${SETTINGS_SECONDARY_SIDEBAR_DEFAULT_WIDTH}px`
        );

        await resizer.trigger('keydown', { key: 'ArrowRight' });
        expect(panel.attributes('style')).toContain(
            `width: ${SETTINGS_SECONDARY_SIDEBAR_DEFAULT_WIDTH + SETTINGS_RESIZE_KEYBOARD_STEP}px`
        );

        await resizer.trigger('keydown', { key: 'End' });
        expect(panel.attributes('style')).toContain(
            `width: ${SETTINGS_SECONDARY_SIDEBAR_MAX_WIDTH}px`
        );

        await resizer.trigger('keydown', { key: 'Home' });
        expect(panel.attributes('style')).toContain(
            `width: ${SETTINGS_SECONDARY_SIDEBAR_MIN_WIDTH}px`
        );

        await resizer.trigger('keydown', { key: 'ArrowLeft' });
        expect(panel.attributes('style')).toContain(
            `width: ${SETTINGS_SECONDARY_SIDEBAR_MIN_WIDTH}px`
        );
    });
});
