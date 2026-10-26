import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';

/*
 * The context menu composable keeps two defensive paths that a normal menu never
 * reaches: an action list that turns out to be empty, and a menu component that
 * does not expose its own close(). Both are user-visible — an empty menu must not
 * trap the keyboard, and a menu without a close method must still go away — so
 * they are driven through the same public surface as the ordinary cases.
 */

vi.mock('@components/ContextMenu.vue', async () => {
    const { defineComponent: component, h: render, ref: state } = await import('vue');

    return {
        default: component({
            props: {
                x: { type: Number, required: true },
                y: { type: Number, required: true },
                items: { type: Array, required: true },
                menuId: { type: String, required: true },
            },
            emits: ['select', 'close', 'closed'],
            setup(props, { emit, expose }) {
                const open = state(true);
                // Closing twice is what a menu does when its exit animation and its
                // Escape handler both fire.
                expose({
                    close: () => {
                        open.value = false;
                        emit('close');
                        emit('close');
                    },
                });

                return () =>
                    render(
                        'div',
                        {
                            role: 'menu',
                            'data-context-menu-id': props.menuId,
                            'data-state': open.value ? 'open' : 'closed',
                        },
                        (props.items as Array<{ key: string; label: string }>).map((item) =>
                            render(
                                'button',
                                {
                                    role: 'menuitem',
                                    onClick: () => emit('select', item.key),
                                },
                                item.label
                            )
                        )
                    );
            },
        }),
    };
});

import { type ContextMenuItem, useContextMenu } from '@/composables/useContextMenu';

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
});

function mountMenu(items: ContextMenuItem[], onSelect = vi.fn(), onClose = vi.fn()) {
    const Harness = defineComponent({
        setup(_, { expose }) {
            const menu = useContextMenu(items, onSelect, onClose);
            expose(menu);
            return () => h('div');
        },
    });
    const wrapper = mount(Harness, { attachTo: document.body });
    return {
        wrapper,
        menu: wrapper.vm as unknown as ReturnType<typeof useContextMenu>,
        onSelect,
        onClose,
    };
}

const pointerEvent = (x = 20, y = 30) =>
    ({ preventDefault: vi.fn(), clientX: x, clientY: y }) as unknown as MouseEvent;

function menuRoot(): HTMLElement | null {
    return document.querySelector<HTMLElement>('[data-context-menu-id][role="menu"]');
}

function pressKey(key: string) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

async function openAndSettle(menu: ReturnType<typeof useContextMenu>) {
    menu.open(pointerEvent());
    await new Promise((resolve) => setTimeout(resolve, 24));
}

describe('user opens a menu that has no actions', () => {
    it('user gets an empty menu rather than a crash', async () => {
        const { wrapper, menu } = mountMenu([]);

        await openAndSettle(menu);

        expect(menuRoot()).not.toBeNull();
        expect(menuRoot()?.querySelectorAll('[role="menuitem"]')).toHaveLength(0);
        wrapper.unmount();
    });

    it('user gets no highlight attempt on an empty menu', async () => {
        const { wrapper, menu } = mountMenu([]);
        await openAndSettle(menu);

        expect(() => pressKey('ArrowDown')).not.toThrow();
        expect(menuRoot()?.querySelectorAll('[data-highlighted]')).toHaveLength(0);
        wrapper.unmount();
    });

    it('user gets nothing run when pressing Enter on an empty menu', async () => {
        const { wrapper, menu, onSelect } = mountMenu([]);
        await openAndSettle(menu);

        pressKey('Enter');

        expect(onSelect).not.toHaveBeenCalled();
        wrapper.unmount();
    });

    it('user gets the empty menu dismissed with Escape like any other', async () => {
        const { wrapper, menu, onClose } = mountMenu([]);
        await openAndSettle(menu);

        pressKey('Escape');
        await wrapper.vm.$nextTick();

        expect(onClose).toHaveBeenCalledOnce();
        expect(menuRoot()?.getAttribute('data-state')).toBe('closed');
        wrapper.unmount();
    });

    it('user gets the arrow keys still kept away from the page behind', async () => {
        const { wrapper, menu } = mountMenu([]);
        await openAndSettle(menu);

        const event = new KeyboardEvent('keydown', {
            key: 'ArrowUp',
            bubbles: true,
            cancelable: true,
        });
        document.dispatchEvent(event);

        expect(event.defaultPrevented).toBe(true);
        wrapper.unmount();
    });
});

describe('user closes a menu while it is already closing', () => {
    it('user gets the close reported once and the menu removed once', async () => {
        vi.useFakeTimers();
        const { wrapper, menu, onClose } = mountMenu([{ key: 'one', label: 'One' }]);
        menu.open(pointerEvent());
        await vi.advanceTimersByTimeAsync(24);

        // Two closes in a row: the exit animation is already scheduled, so the
        // second must not schedule another disposal.
        menu.close();
        menu.close();
        await vi.advanceTimersByTimeAsync(700);

        expect(onClose).toHaveBeenCalledOnce();
        expect(menuRoot()).toBeNull();
        wrapper.unmount();
    });

    it('user gets no second menu left behind after closing twice', async () => {
        const { wrapper, menu } = mountMenu([{ key: 'one', label: 'One' }]);
        await openAndSettle(menu);

        menu.close();
        menu.close();
        await wrapper.vm.$nextTick();

        expect(document.querySelectorAll('[data-context-menu-id][role="menu"]')).toHaveLength(1);
        wrapper.unmount();
    });

    it('user gets the page torn down cleanly after a double close', async () => {
        const { wrapper, menu } = mountMenu([{ key: 'one', label: 'One' }]);
        await openAndSettle(menu);
        menu.close();
        menu.close();

        expect(() => wrapper.unmount()).not.toThrow();
        expect(menuRoot()).toBeNull();
    });
});

describe('user closes a menu whose component reports the close twice', () => {
    it('user gets one close notification even when the component reports it twice', async () => {
        const { wrapper, menu, onClose } = mountMenu([
            { key: 'one', label: 'One' },
            { key: 'two', label: 'Two' },
        ]);
        await openAndSettle(menu);

        menu.close();
        await wrapper.vm.$nextTick();

        expect(onClose).toHaveBeenCalledOnce();
        wrapper.unmount();
    });

    it('user gets the menu removed once after the exit animation, not twice', async () => {
        vi.useFakeTimers();
        const { wrapper, menu } = mountMenu([{ key: 'one', label: 'One' }]);
        menu.open(pointerEvent());
        await vi.advanceTimersByTimeAsync(24);

        menu.close();
        await vi.advanceTimersByTimeAsync(700);

        expect(menuRoot()).toBeNull();
        wrapper.unmount();
    });

    it('user gets nothing thrown when the page tears down after such a close', async () => {
        const { wrapper, menu } = mountMenu([{ key: 'one', label: 'One' }]);
        await openAndSettle(menu);
        menu.close();

        expect(() => wrapper.unmount()).not.toThrow();
    });
});
