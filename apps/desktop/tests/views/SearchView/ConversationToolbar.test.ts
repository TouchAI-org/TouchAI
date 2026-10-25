import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ConversationToolbar from '@/views/SearchView/components/ConversationPanel/components/ConversationToolbar.vue';

/**
 * The toolbar floats over the conversation. Its buttons must not start a window drag, and a
 * disabled toolbar must swallow its actions rather than half-apply them.
 */
const { startDraggingMock } = vi.hoisted(() => ({ startDraggingMock: vi.fn() }));

vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => ({ startDragging: startDraggingMock }),
}));

function mountToolbar(props = {}) {
    return mount(ConversationToolbar, {
        props: {
            isPinned: false,
            historyOpen: false,
            ...props,
        },
        global: {
            stubs: {
                AppIcon: { props: ['name'], template: '<i :data-icon="name" />' },
            },
        },
    });
}

function buttonByIcon(wrapper: ReturnType<typeof mountToolbar>, icon: string) {
    return wrapper
        .findAll('button')
        .find((button) => button.find(`[data-icon="${icon}"]`).exists());
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe('user uses the conversation toolbar', () => {
    it('user clicks new session and the action is reported', async () => {
        const wrapper = mountToolbar();

        await buttonByIcon(wrapper, 'plus')!.trigger('click');

        expect(wrapper.emitted('newSession')).toHaveLength(1);
        wrapper.unmount();
    });

    it('user clicks new session on a disabled toolbar and nothing happens', async () => {
        const wrapper = mountToolbar({ disabled: true });

        await buttonByIcon(wrapper, 'plus')!.trigger('click');

        // A disabled toolbar must not act at all, not act and then look disabled.
        expect(wrapper.emitted('newSession')).toBeUndefined();
        wrapper.unmount();
    });

    it('user opens the history and the new open state is reported', async () => {
        const wrapper = mountToolbar({ historyOpen: false });

        await buttonByIcon(wrapper, 'chat-history')!.trigger('click');

        const events = wrapper.emitted('historyOpenChange')!;
        expect(events[0]![0]).toMatchObject({ open: true });
        wrapper.unmount();
    });

    it('user closes an open history and the new open state is reported', async () => {
        const wrapper = mountToolbar({ historyOpen: true });

        await buttonByIcon(wrapper, 'chat-history')!.trigger('click');

        expect(wrapper.emitted('historyOpenChange')![0]![0]).toMatchObject({ open: false });
        wrapper.unmount();
    });

    it('user hovers the history button and the prefetch is requested once', async () => {
        const wrapper = mountToolbar();

        await buttonByIcon(wrapper, 'chat-history')!.trigger('mouseenter');

        expect(wrapper.emitted('historyPrefetch')).toHaveLength(1);
        wrapper.unmount();
    });

    it('user hovers a disabled toolbar and no prefetch is requested', async () => {
        const wrapper = mountToolbar({ disabled: true });

        await buttonByIcon(wrapper, 'chat-history')!.trigger('mouseenter');

        expect(wrapper.emitted('historyPrefetch')).toBeUndefined();
        wrapper.unmount();
    });

    it('user drags the empty part of the toolbar and the window moves', async () => {
        const wrapper = mountToolbar();

        const overlay = wrapper.find('div.toolbar-fade-overlay').element;
        overlay.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
        await wrapper.vm.$nextTick();

        expect(wrapper.emitted('dragStart')).toHaveLength(1);
        expect(startDraggingMock).toHaveBeenCalled();
        wrapper.unmount();
    });

    it('user drags from a button and the window does not move', async () => {
        const wrapper = mountToolbar();
        const button = buttonByIcon(wrapper, 'plus')!.element;

        // The buttons stop the event themselves; this checks the toolbar's own guard too.
        const event = new MouseEvent('mousedown', { button: 0, bubbles: true });
        Object.defineProperty(event, 'target', { value: button });
        wrapper.find('div.toolbar-fade-overlay').element.dispatchEvent(event);
        await wrapper.vm.$nextTick();

        expect(wrapper.emitted('dragStart')).toBeUndefined();
        expect(startDraggingMock).not.toHaveBeenCalled();
        wrapper.unmount();
    });

    it('user presses a non-left button on the toolbar and the window does not move', async () => {
        const wrapper = mountToolbar();

        const overlay = wrapper.find('div.toolbar-fade-overlay').element;
        overlay.dispatchEvent(new MouseEvent('mousedown', { button: 2, bubbles: true }));
        await wrapper.vm.$nextTick();

        expect(startDraggingMock).not.toHaveBeenCalled();
        wrapper.unmount();
    });

    it('user scrolls over the toolbar and the delta is reported', async () => {
        const wrapper = mountToolbar();

        await wrapper.find('div.toolbar-fade-overlay').trigger('wheel', { deltaY: 42 });

        expect(wrapper.emitted('wheel')).toEqual([[42]]);
        wrapper.unmount();
    });

    it('user gets every toolbar button labelled for assistive technology', () => {
        const wrapper = mountToolbar();

        const buttons = wrapper.findAll('button');
        expect(buttons.length).toBeGreaterThanOrEqual(3);
        for (const button of buttons) {
            expect(button.attributes('aria-label')).toBeTruthy();
        }
        wrapper.unmount();
    });

    it('user gets the history anchor exposed so a popover can attach to it', () => {
        const wrapper = mountToolbar();

        const anchor = (
            wrapper.vm as unknown as { getHistoryAnchor: () => HTMLElement | null }
        ).getHistoryAnchor();

        expect(anchor).toBeTruthy();
        expect(anchor!.hasAttribute('data-history-trigger')).toBe(true);
        wrapper.unmount();
    });
});
