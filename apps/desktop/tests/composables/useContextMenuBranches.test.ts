import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';

/*
 * The context menu is a keyboard surface a user drives with Escape, the arrow keys
 * and Enter. Its menu items only exist inside the real component, so the fake here
 * renders the same `role="menu"` / `role="menuitem"` structure the real one does
 * and records which item was selected. Every assertion below is about what the
 * user sees happen (a menu appears, a highlight moves, a key selects) rather than
 * about the composable's bookkeeping.
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
                const close = () => {
                    if (!open.value) return;
                    open.value = false;
                    emit('close');
                };
                // An item may report itself as unselectable; the real menu uses this
                // to keep separators out of the keyboard walk.
                expose({ close });

                return () =>
                    render(
                        'div',
                        {
                            role: 'menu',
                            'data-context-menu-id': props.menuId,
                            'data-state': open.value ? 'open' : 'closed',
                            onAnimationend: (event: AnimationEvent) => {
                                if (event.animationName === 't-dropdown-out') emit('closed');
                            },
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

type MenuApi = ReturnType<typeof useContextMenu>;

const items: ContextMenuItem[] = [
    { key: 'copy', label: 'Copy' },
    { key: 'rename', label: 'Rename' },
    { key: 'delete', label: 'Delete', danger: true },
];

function mountMenu(
    options: {
        onSelect?: (key: string, context: unknown) => void;
        onClose?: () => void;
        source?: ContextMenuItem[] | (() => ContextMenuItem[]);
    } = {}
) {
    const onSelect = vi.fn(options.onSelect);
    const onClose = vi.fn(options.onClose);
    const Harness = defineComponent({
        setup(_, { expose }) {
            const menu = useContextMenu(
                options.source ?? items,
                onSelect as (key: string, context: unknown) => void,
                onClose
            );
            expose(menu);
            return () => h('div');
        },
    });
    const wrapper = mount(Harness, { attachTo: document.body });
    return { wrapper, menu: wrapper.vm as unknown as MenuApi, onSelect, onClose };
}

const pointerEvent = (x = 20, y = 30) =>
    ({
        preventDefault: vi.fn(),
        clientX: x,
        clientY: y,
    }) as unknown as MouseEvent;

function menuRoot(): HTMLElement | null {
    return document.querySelector<HTMLElement>('[data-context-menu-id][role="menu"]');
}

function menuItems(): HTMLElement[] {
    return Array.from(menuRoot()?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
}

function highlighted(): number {
    return menuItems().findIndex((node) => node.hasAttribute('data-highlighted'));
}

function pressKey(key: string) {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    return event;
}

async function openAndSettle(menu: MenuApi, x = 20, y = 30) {
    menu.open(pointerEvent(x, y));
    await new Promise((resolve) => setTimeout(resolve, 24));
}

describe('user opens a context menu', () => {
    it('user gets a menu at the pointer with every action listed', async () => {
        const { wrapper, menu } = mountMenu();

        await openAndSettle(menu);

        expect(menuRoot()).not.toBeNull();
        expect(menuItems().map((node) => node.textContent)).toEqual(['Copy', 'Rename', 'Delete']);
        wrapper.unmount();
    });

    it('user gets the first action highlighted as soon as the menu is usable', async () => {
        const { wrapper, menu } = mountMenu();

        await openAndSettle(menu);

        expect(highlighted()).toBe(0);
        wrapper.unmount();
    });

    it('user gets the browser menu suppressed so only the app menu shows', () => {
        const { wrapper, menu } = mountMenu();
        const event = pointerEvent();

        menu.open(event);

        expect(event.preventDefault).toHaveBeenCalled();
        wrapper.unmount();
    });

    it('user gets the actions read fresh each time when the caller supplies a function', async () => {
        let current: ContextMenuItem[] = [{ key: 'first', label: 'First' }];
        const { wrapper, menu } = mountMenu({ source: () => current });

        await openAndSettle(menu);
        expect(menuItems().map((node) => node.textContent)).toEqual(['First']);

        menu.close();
        current = [{ key: 'second', label: 'Second' }];
        await openAndSettle(menu);
        expect(menuItems().map((node) => node.textContent)).toEqual(['Second']);

        wrapper.unmount();
    });

    it('user gets only one menu when they right-click somewhere else', async () => {
        const { wrapper, menu } = mountMenu();

        await openAndSettle(menu, 10, 12);
        const firstId = menuRoot()?.getAttribute('data-context-menu-id');

        await openAndSettle(menu, 40, 50);

        const roots = document.querySelectorAll('[data-context-menu-id][role="menu"]');
        expect(roots).toHaveLength(1);
        expect(roots[0]?.getAttribute('data-context-menu-id')).not.toBe(firstId);
        wrapper.unmount();
    });
});

describe('user walks the menu with the keyboard', () => {
    it('user gets the next action highlighted on arrow down', async () => {
        const { wrapper, menu } = mountMenu();
        await openAndSettle(menu);

        pressKey('ArrowDown');

        expect(highlighted()).toBe(1);
        wrapper.unmount();
    });

    it('user gets the previous action highlighted on arrow up', async () => {
        const { wrapper, menu } = mountMenu();
        await openAndSettle(menu);

        pressKey('ArrowUp');

        // Wraps from the first action to the last one.
        expect(highlighted()).toBe(2);
        wrapper.unmount();
    });

    it('user wraps back to the first action after the last one', async () => {
        const { wrapper, menu } = mountMenu();
        await openAndSettle(menu);

        pressKey('ArrowDown');
        pressKey('ArrowDown');
        pressKey('ArrowDown');

        expect(highlighted()).toBe(0);
        wrapper.unmount();
    });

    it('user gets the highlighted action run when pressing Enter', async () => {
        const { wrapper, menu, onSelect } = mountMenu();
        await openAndSettle(menu);
        pressKey('ArrowDown');

        pressKey('Enter');

        expect(onSelect).toHaveBeenCalledWith('rename', undefined);
        wrapper.unmount();
    });

    it('user gets the context they opened the menu for handed to the action', async () => {
        const { wrapper, menu, onSelect } = mountMenu();
        menu.open(pointerEvent(), { sessionId: 42 });
        await new Promise((resolve) => setTimeout(resolve, 24));

        pressKey('Enter');

        expect(onSelect).toHaveBeenCalledWith('copy', { sessionId: 42 });
        wrapper.unmount();
    });

    it('user gets the arrow keys and Enter kept away from the page behind', async () => {
        const { wrapper, menu } = mountMenu();
        await openAndSettle(menu);

        expect(pressKey('ArrowDown').defaultPrevented).toBe(true);
        expect(pressKey('Enter').defaultPrevented).toBe(true);
        wrapper.unmount();
    });

    it('user gets a key the menu does not use passed over without a highlight change', async () => {
        const { wrapper, menu } = mountMenu();
        await openAndSettle(menu);
        pressKey('ArrowDown');

        pressKey('a');

        expect(highlighted()).toBe(1);
        wrapper.unmount();
    });

    it('user gets the menu dismissed with Escape', async () => {
        const { wrapper, menu, onClose } = mountMenu();
        await openAndSettle(menu);

        pressKey('Escape');
        await wrapper.vm.$nextTick();

        expect(onClose).toHaveBeenCalledOnce();
        expect(menuRoot()?.getAttribute('data-state')).toBe('closed');
        wrapper.unmount();
    });

    it('user gets the menu dismissed by the older Esc spelling too', async () => {
        const { wrapper, menu, onClose } = mountMenu();
        await openAndSettle(menu);

        pressKey('Esc');

        expect(onClose).toHaveBeenCalledOnce();
        wrapper.unmount();
    });

    it('user gets the keyboard released once the menu starts closing', async () => {
        const { wrapper, menu } = mountMenu();
        await openAndSettle(menu);
        menu.close();
        await wrapper.vm.$nextTick();

        // A stray arrow must not move a highlight in a menu that is on its way out.
        pressKey('ArrowDown');

        expect(highlighted()).toBe(0);
        wrapper.unmount();
    });
});

describe('user closes the menu', () => {
    it('user gets the menu taken off screen after its exit animation', async () => {
        const { wrapper, menu } = mountMenu();
        await openAndSettle(menu);
        menu.close();
        await wrapper.vm.$nextTick();

        const animationEnd = new Event('animationend') as AnimationEvent;
        Object.defineProperty(animationEnd, 'animationName', { value: 't-dropdown-out' });
        menuRoot()?.dispatchEvent(animationEnd);

        expect(menuRoot()).toBeNull();
        wrapper.unmount();
    });

    it('user gets the menu removed anyway when no animation ever arrives', async () => {
        vi.useFakeTimers();
        const { wrapper, menu } = mountMenu();
        menu.open(pointerEvent());
        await vi.advanceTimersByTimeAsync(24);

        menu.close();
        await vi.advanceTimersByTimeAsync(700);

        expect(menuRoot()).toBeNull();
        wrapper.unmount();
    });

    it('user gets the close reported once even when closing is asked for twice', async () => {
        const { wrapper, menu, onClose } = mountMenu();
        await openAndSettle(menu);

        menu.close();
        menu.close();

        expect(onClose).toHaveBeenCalledOnce();
        wrapper.unmount();
    });

    it('user gets no close reported when they open a second menu over the first', async () => {
        const { wrapper, menu, onClose } = mountMenu();
        await openAndSettle(menu);

        menu.open(pointerEvent(40, 50));

        expect(onClose).not.toHaveBeenCalled();
        wrapper.unmount();
    });

    it('user gets closing a menu that was never opened ignored', () => {
        const { wrapper, menu, onClose } = mountMenu();

        menu.close();

        // Nothing was open, so there is nothing to report and nothing to tear down.
        expect(onClose).not.toHaveBeenCalled();
        expect(menuRoot()).toBeNull();
        wrapper.unmount();
    });

    it('user gets the menu cleaned up when the page that owns it goes away', async () => {
        const { wrapper, menu } = mountMenu();
        await openAndSettle(menu);

        wrapper.unmount();

        expect(menuRoot()).toBeNull();
    });

    it('user gets the close reported when the page is torn down with a menu open', async () => {
        const { wrapper, menu, onClose } = mountMenu();
        await openAndSettle(menu);

        wrapper.unmount();

        // Tearing down is not a user close: no notification is due.
        expect(onClose).not.toHaveBeenCalled();
    });
});
