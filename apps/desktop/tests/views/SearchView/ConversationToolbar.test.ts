import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { t } from '@/i18n';
import ConversationToolbar from '@/views/SearchView/components/ConversationPanel/components/ConversationToolbar.vue';

/**
 * The toolbar floats over the conversation. Its buttons must not start a window drag, and a
 * disabled toolbar must swallow its actions rather than half-apply them.
 */
const startDraggingMock = vi.fn();

function mountToolbar(props = {}) {
    return mount(ConversationToolbar, {
        props: {
            startDragging: startDraggingMock,
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

function buttonByLabel(wrapper: ReturnType<typeof mountToolbar>, label: string) {
    return wrapper.findAll('button').find((button) => button.attributes('aria-label') === label);
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe('user uses the conversation toolbar', () => {
    it('user clicks new session and the action is reported', async () => {
        const wrapper = mountToolbar();

        await buttonByLabel(wrapper, t('conversation.toolbar.newSession'))!.trigger('click');

        expect(wrapper.emitted('newSession')).toHaveLength(1);
        wrapper.unmount();
    });

    it('user clicks new session on a disabled toolbar and nothing happens', async () => {
        const wrapper = mountToolbar({ disabled: true });

        await buttonByLabel(wrapper, t('conversation.toolbar.newSession'))!.trigger('click');

        // A disabled toolbar must not act at all, not act and then look disabled.
        expect(wrapper.emitted('newSession')).toBeUndefined();
        wrapper.unmount();
    });

    it('user opens the history and the new open state is reported', async () => {
        const wrapper = mountToolbar({ historyOpen: false });

        await buttonByLabel(wrapper, t('conversation.toolbar.openHistory'))!.trigger('click');

        const events = wrapper.emitted('historyOpenChange')!;
        expect(events[0]![0]).toMatchObject({ open: true });
        wrapper.unmount();
    });

    it('user closes an open history and the new open state is reported', async () => {
        const wrapper = mountToolbar({ historyOpen: true });

        await buttonByLabel(wrapper, t('conversation.toolbar.openHistory'))!.trigger('click');

        expect(wrapper.emitted('historyOpenChange')![0]![0]).toMatchObject({ open: false });
        wrapper.unmount();
    });

    it('user hovers the history button and the prefetch is requested once', async () => {
        const wrapper = mountToolbar();

        await buttonByLabel(wrapper, t('conversation.toolbar.openHistory'))!.trigger('mouseenter');

        expect(wrapper.emitted('historyPrefetch')).toHaveLength(1);
        wrapper.unmount();
    });

    it('user hovers a disabled toolbar and no prefetch is requested', async () => {
        const wrapper = mountToolbar({ disabled: true });

        await buttonByLabel(wrapper, t('conversation.toolbar.openHistory'))!.trigger('mouseenter');

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
        const button = buttonByLabel(wrapper, t('conversation.toolbar.newSession'))!.element;

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

    it('user sees the same maximize and restore glyphs as the window chrome', async () => {
        const wrapper = mountToolbar({ isMaximized: false });

        expect(buttonByIcon(wrapper, 'maximize-square')).toBeTruthy();
        await buttonByLabel(wrapper, t('conversation.toolbar.maximizeWindow'))!.trigger('click');
        expect(wrapper.emitted('maximizeToggle')).toHaveLength(1);

        await wrapper.setProps({ isMaximized: true });
        expect(buttonByIcon(wrapper, 'restore-square')).toBeTruthy();

        wrapper.unmount();
    });

    it('user finds the maximize control at the far right of the toolbar', () => {
        const wrapper = mountToolbar({ isPinned: true, isMaximized: false });

        const buttons = wrapper.findAll('button');
        expect(buttons.at(-1)!.find('[data-icon="maximize-square"]').exists()).toBe(true);

        wrapper.unmount();
    });

    it('user sees session actions on the left and window controls on the right', () => {
        const wrapper = mountToolbar({ isPinned: true, isMaximized: false });

        const groups = wrapper.find('[data-slot="conversation-toolbar"]').element.children;
        expect(groups).toHaveLength(2);
        expect(groups[0]!.querySelector('[data-icon="new-session"]')).toBeTruthy();
        expect(groups[0]!.querySelector('[data-icon="session-history"]')).toBeTruthy();
        expect(groups[1]!.querySelector('[data-icon="pin"]')).toBeTruthy();
        expect(groups[1]!.querySelector('[data-icon="maximize-square"]')).toBeTruthy();

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
