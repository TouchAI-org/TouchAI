import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick } from 'vue';

import ConfirmDialog from '@/components/ConfirmDialog.vue';
import ContextMenu from '@/components/ContextMenu.vue';
import { useConfirm } from '@/composables/useConfirm';
import { useContextMenu } from '@/composables/useContextMenu';

enableAutoUnmount(afterEach);

beforeEach(() => {
    vi.stubGlobal('CSS', { escape: (value: string) => value });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

const items = [{ key: 'copy', label: 'Copy' }];

function menuItem(): HTMLElement {
    const item = document.querySelector<HTMLElement>('[role=menuitem]');
    expect(item).not.toBeNull();
    return item!;
}

function button(label: string): HTMLButtonElement {
    const element = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
        (candidate) => candidate.textContent?.trim() === label
    );
    expect(element).toBeDefined();
    return element!;
}

function exitAnimation(name: string): Event {
    const event = new Event('animationend', { bubbles: true });
    Object.defineProperty(event, 'animationName', { value: name });
    return event;
}

function mountInteractions() {
    const selections: string[] = [];
    const closes: string[] = [];
    const wrapper = mount(
        defineComponent({
            setup(_props, { expose }) {
                expose({
                    menu: useContextMenu(
                        items,
                        (key) => selections.push(key),
                        () => closes.push('closed')
                    ),
                    ...useConfirm(),
                });
                return () => h('div');
            },
        }),
        { attachTo: document.body }
    );
    const interactions = wrapper.vm as unknown as {
        menu: ReturnType<typeof useContextMenu>;
        confirm: ReturnType<typeof useConfirm>['confirm'];
    };
    return { wrapper, interactions, selections, closes };
}

describe('user interacts with an open context menu', () => {
    it('user runs an action once when two clicks arrive before the next render', async () => {
        const wrapper = mount(ContextMenu, {
            props: { x: 10, y: 20, items, menuId: 'double-click' },
            attachTo: document.body,
        });
        await flushPromises();

        const item = menuItem();
        item.click();
        item.click();
        await nextTick();

        expect(wrapper.emitted('select')).toEqual([['copy']]);
        expect(wrapper.emitted('close')).toEqual([[]]);
    });

    it('user cannot run an action after dismissing its menu', async () => {
        const { interactions, selections, closes } = mountInteractions();
        interactions.menu.open(new MouseEvent('contextmenu'));
        await flushPromises();
        const item = menuItem();

        interactions.menu.close();
        item.click();
        await nextTick();

        expect(selections).toEqual([]);
        expect(closes).toEqual(['closed']);
    });

    it('user can select from a replacement without the old menu reporting a close', async () => {
        const { interactions, selections, closes } = mountInteractions();
        interactions.menu.open(new MouseEvent('contextmenu'));
        await flushPromises();
        const oldMenu = document.querySelector('[role=menu]')!;

        interactions.menu.open(new MouseEvent('contextmenu'));
        await flushPromises();
        oldMenu.dispatchEvent(exitAnimation('t-dropdown-out'));
        menuItem().click();
        await nextTick();

        expect(selections).toEqual(['copy']);
        expect(closes).toEqual(['closed']);
    });
});

describe('user answers a confirmation', () => {
    it('user keeps the first answer when another button is activated before rendering', async () => {
        const { interactions } = mountInteractions();
        const answer = interactions.confirm({
            message: 'Keep this change?',
            confirmText: 'Keep',
            cancelText: 'Discard',
        });
        await flushPromises();
        const confirm = button('Keep');
        const cancel = button('Discard');

        confirm.click();
        cancel.click();

        await expect(answer).resolves.toBe(true);
    });

    it('user gets a cancellation when a pending confirmation is replaced or its owner leaves', async () => {
        const { wrapper, interactions } = mountInteractions();
        const first = interactions.confirm({ message: 'First question?' });
        await flushPromises();

        const second = interactions.confirm({ message: 'Second question?' });
        await expect(first).resolves.toBe(false);
        await flushPromises();
        expect(document.querySelector('[role=alertdialog]')?.textContent).toContain(
            'Second question?'
        );

        wrapper.unmount();
        await expect(second).resolves.toBe(false);
        await flushPromises();
        expect(document.querySelector('[role=alertdialog]')).toBeNull();
    });

    it('user can answer a reopened confirmation when an old exit event arrives', async () => {
        const wrapper = mount(ConfirmDialog, {
            props: {
                open: true,
                message: 'Keep this change?',
                confirmText: 'Keep',
                cancelText: 'Discard',
            },
            attachTo: document.body,
        });
        await flushPromises();
        await wrapper.setProps({ open: false });
        await wrapper.setProps({ open: true });
        await flushPromises();

        document.querySelector('[role=alertdialog]')!.dispatchEvent(exitAnimation('t-modal-out'));
        button('Keep').click();
        await nextTick();

        expect(wrapper.emitted('closed')).toBeUndefined();
        expect(wrapper.emitted('confirm')).toEqual([[]]);
        expect(wrapper.emitted('cancel')).toEqual([[]]);
    });
});
