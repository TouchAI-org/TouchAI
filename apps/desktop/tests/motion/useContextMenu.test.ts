import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick } from 'vue';

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
    vi.restoreAllMocks();
    vi.useRealTimers();
});

type MenuApi = ReturnType<typeof useContextMenu>;

function mountMenu(onSelect = vi.fn(), onClose = vi.fn()) {
    const items: ContextMenuItem[] = [
        { key: 'one', label: 'One' },
        { key: 'two', label: 'Two' },
        { key: 'three', label: 'Three' },
    ];
    const Harness = defineComponent({
        setup(_, { expose }) {
            const menu = useContextMenu(items, onSelect, onClose);
            expose(menu);
            return () => h('div');
        },
    });
    const wrapper = mount(Harness, { attachTo: document.body });
    return { wrapper, menu: wrapper.vm as unknown as MenuApi, onSelect, onClose };
}

const mouseEvent = (x = 20, y = 30) =>
    ({
        preventDefault: vi.fn(),
        clientX: x,
        clientY: y,
    }) as unknown as MouseEvent;

describe('context menu motion lifecycle', () => {
    it('uses a per-instance selector and keeps keyboard controls active until close starts', async () => {
        const { wrapper, menu, onClose } = mountMenu();
        menu.open(mouseEvent());
        await nextTick();
        await new Promise((resolve) => setTimeout(resolve, 24));

        const root = document.querySelector<HTMLElement>('[data-context-menu-id][role="menu"]');
        const items = root?.querySelectorAll<HTMLElement>('[role="menuitem"]');
        expect(root).not.toBeNull();
        expect(items).toHaveLength(3);
        expect(items?.[0]?.hasAttribute('data-highlighted')).toBe(true);

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        expect(items?.[1]?.hasAttribute('data-highlighted')).toBe(true);
        expect(items?.[0]?.hasAttribute('data-highlighted')).toBe(false);

        menu.close();
        await nextTick();
        expect(onClose).toHaveBeenCalledOnce();
        expect(root?.getAttribute('data-state')).toBe('closed');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
        expect(items?.[1]?.hasAttribute('data-highlighted')).toBe(true);

        const animationEnd = new Event('animationend') as AnimationEvent;
        Object.defineProperty(animationEnd, 'animationName', { value: 't-dropdown-out' });
        root?.dispatchEvent(animationEnd);
        expect(document.querySelector('[data-context-menu-id][role="menu"]')).toBeNull();
        wrapper.unmount();
    });

    it('disposes an old menu on immediate reopen and cleans the active one with its scope', async () => {
        const { wrapper, menu } = mountMenu();
        menu.open(mouseEvent(10, 12));
        await nextTick();
        const firstId = document
            .querySelector('[data-context-menu-id]')
            ?.getAttribute('data-context-menu-id');

        menu.open(mouseEvent(40, 50));
        await nextTick();
        const roots = document.querySelectorAll('[data-context-menu-id][role="menu"]');
        expect(roots).toHaveLength(1);
        expect(roots[0]?.getAttribute('data-context-menu-id')).not.toBe(firstId);

        wrapper.unmount();
        expect(document.querySelector('[data-context-menu-id][role="menu"]')).toBeNull();
    });
});
