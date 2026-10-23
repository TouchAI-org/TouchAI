// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3.

/**
 * The resizable settings panel, tested through the component that hosts it:
 * what a user can drag or resize with the keyboard, not the composable's refs.
 */
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';

import { useSettingsResizablePanel } from '@/views/SettingsView/composables/useSettingsResizablePanel';
import {
    SETTINGS_SECONDARY_PANEL_RESIZE_EVENT,
    SETTINGS_SECONDARY_SIDEBAR_DEFAULT_WIDTH,
    SETTINGS_SECONDARY_SIDEBAR_MIN_WIDTH,
} from '@/views/SettingsView/settingsSidebarLayout';

const Host = defineComponent({
    name: 'ResizablePanelHost',
    setup() {
        const { handleResizeKeyDown, handleResizePointerDown, panelStyle } =
            useSettingsResizablePanel();
        return () =>
            h('div', [
                h('div', { 'data-testid': 'panel', style: panelStyle.value }),
                h('div', {
                    'data-testid': 'handle',
                    role: 'separator',
                    tabindex: 0,
                    onPointerdown: handleResizePointerDown,
                    onKeydown: handleResizeKeyDown,
                }),
            ]);
    },
});

function mountPanel(): ReturnType<typeof mount> {
    return mount(Host, { attachTo: document.body });
}

function panelWidth(wrapper: ReturnType<typeof mount>): number {
    return Number.parseFloat(
        (wrapper.get('[data-testid="panel"]').element as HTMLElement).style.width
    );
}

function pointer(type: string, init: PointerEventInit): PointerEvent {
    return new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, ...init });
}

async function drag(
    wrapper: ReturnType<typeof mount>,
    from: number,
    to: number,
    pointerId = 1
): Promise<void> {
    wrapper
        .get('[data-testid="handle"]')
        .element.dispatchEvent(pointer('pointerdown', { button: 0, clientX: from, pointerId }));
    window.dispatchEvent(pointer('pointermove', { clientX: to, pointerId }));
    window.dispatchEvent(pointer('pointerup', { clientX: to, pointerId }));
    await flushPromises();
}

let resizeEvents = 0;

beforeEach(() => {
    document.body.innerHTML = '';
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    resizeEvents = 0;
    window.innerWidth = 1440;
    window.addEventListener(SETTINGS_SECONDARY_PANEL_RESIZE_EVENT, () => {
        resizeEvents += 1;
    });
});

describe('user resizes the settings side panel', () => {
    it('user sees the panel at its default width on first render', () => {
        const wrapper = mountPanel();

        expect(panelWidth(wrapper)).toBe(SETTINGS_SECONDARY_SIDEBAR_DEFAULT_WIDTH);
    });

    it('user widens the panel by dragging the handle to the right', async () => {
        const wrapper = mountPanel();

        await drag(wrapper, 600, 660);

        expect(panelWidth(wrapper)).toBe(SETTINGS_SECONDARY_SIDEBAR_DEFAULT_WIDTH + 60);
    });

    it('user cannot drag the panel below its minimum width', async () => {
        const wrapper = mountPanel();

        await drag(wrapper, 600, 0);

        expect(panelWidth(wrapper)).toBe(SETTINGS_SECONDARY_SIDEBAR_MIN_WIDTH);
    });

    it('user sees the panel follow only the pointer that started the drag', async () => {
        const wrapper = mountPanel();
        const handle = wrapper.get('[data-testid="handle"]');

        handle.element.dispatchEvent(pointer('pointerdown', { button: 0, clientX: 600 }));
        window.dispatchEvent(pointer('pointermove', { pointerId: 2, clientX: 900 }));
        await flushPromises();

        expect(panelWidth(wrapper)).toBe(SETTINGS_SECONDARY_SIDEBAR_DEFAULT_WIDTH);

        window.dispatchEvent(pointer('pointermove', { pointerId: 1, clientX: 640 }));
        window.dispatchEvent(pointer('pointerup', { pointerId: 1, clientX: 640 }));
        await flushPromises();

        expect(panelWidth(wrapper)).toBe(SETTINGS_SECONDARY_SIDEBAR_DEFAULT_WIDTH + 40);
    });

    it('user does not start a drag from a right-click', async () => {
        const wrapper = mountPanel();

        wrapper
            .get('[data-testid="handle"]')
            .element.dispatchEvent(pointer('pointerdown', { button: 2, clientX: 600 }));
        window.dispatchEvent(pointer('pointermove', { clientX: 700 }));
        await flushPromises();

        expect(panelWidth(wrapper)).toBe(SETTINGS_SECONDARY_SIDEBAR_DEFAULT_WIDTH);
    });

    it('user sees the resize cursor while dragging and the normal cursor after release', async () => {
        const wrapper = mountPanel();

        wrapper
            .get('[data-testid="handle"]')
            .element.dispatchEvent(pointer('pointerdown', { button: 0, clientX: 600 }));
        expect(document.body.style.cursor).toBe('col-resize');
        expect(document.body.style.userSelect).toBe('none');

        window.dispatchEvent(pointer('pointerup', { clientX: 600 }));

        expect(document.body.style.cursor).toBe('');
        expect(document.body.style.userSelect).toBe('');
    });

    it('user sees the normal cursor restored when the window loses focus mid-drag', async () => {
        const wrapper = mountPanel();

        wrapper
            .get('[data-testid="handle"]')
            .element.dispatchEvent(pointer('pointerdown', { button: 0, clientX: 600 }));
        window.dispatchEvent(new Event('blur'));

        expect(document.body.style.cursor).toBe('');
    });

    it('user widens the panel with the right arrow key and narrows it with the left', async () => {
        const wrapper = mountPanel();
        const handle = wrapper.get('[data-testid="handle"]');

        await handle.trigger('keydown', { key: 'ArrowRight' });
        expect(panelWidth(wrapper)).toBe(SETTINGS_SECONDARY_SIDEBAR_DEFAULT_WIDTH + 16);

        await handle.trigger('keydown', { key: 'ArrowLeft' });
        expect(panelWidth(wrapper)).toBe(SETTINGS_SECONDARY_SIDEBAR_DEFAULT_WIDTH);
    });

    it('user jumps to the narrowest and widest panel with Home and End', async () => {
        const wrapper = mountPanel();
        const handle = wrapper.get('[data-testid="handle"]');

        await handle.trigger('keydown', { key: 'Home' });
        expect(panelWidth(wrapper)).toBe(SETTINGS_SECONDARY_SIDEBAR_MIN_WIDTH);

        await handle.trigger('keydown', { key: 'End' });
        expect(panelWidth(wrapper)).toBeGreaterThan(SETTINGS_SECONDARY_SIDEBAR_MIN_WIDTH);
    });

    it('user keeps the panel size when pressing an unrelated key', async () => {
        const wrapper = mountPanel();
        const handle = wrapper.get('[data-testid="handle"]');

        const event = new KeyboardEvent('keydown', { key: 'a', cancelable: true });
        handle.element.dispatchEvent(event);

        expect(event.defaultPrevented).toBe(false);
        expect(panelWidth(wrapper)).toBe(SETTINGS_SECONDARY_SIDEBAR_DEFAULT_WIDTH);
    });

    it('user sees the neighbouring content reflow when the panel is resized', async () => {
        const wrapper = mountPanel();

        await wrapper.get('[data-testid="handle"]').trigger('keydown', { key: 'ArrowRight' });

        expect(resizeEvents).toBeGreaterThan(0);
    });

    it('user sees the panel shrink back inside the window when the window narrows', async () => {
        const wrapper = mountPanel();
        await wrapper.get('[data-testid="handle"]').trigger('keydown', { key: 'End' });
        const wide = panelWidth(wrapper);

        window.innerWidth = 560;
        window.dispatchEvent(new Event('resize'));
        await flushPromises();

        expect(panelWidth(wrapper)).toBeLessThan(wide);
        expect(panelWidth(wrapper)).toBeGreaterThanOrEqual(SETTINGS_SECONDARY_SIDEBAR_MIN_WIDTH);
    });

    it('user sees the panel leave room for the main sidebar and the detail pane', async () => {
        const sidebar = document.createElement('div');
        sidebar.dataset.testid = 'settings-sidebar';
        sidebar.style.width = '300px';
        document.body.append(sidebar);

        const wrapper = mountPanel();
        window.innerWidth = 1000;
        window.dispatchEvent(new Event('resize'));
        await flushPromises();

        expect(panelWidth(wrapper)).toBeLessThanOrEqual(1000 - 300 - 360);
    });
});
