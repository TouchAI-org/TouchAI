import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import ContextMenu from '@/components/ContextMenu.vue';

/**
 * The context menu is spawned at the pointer. It has to report the chosen item exactly once and
 * report its close exactly once, because the caller unmounts it on close: a missing close leaves
 * an invisible menu swallowing clicks, and a duplicate one unmounts twice.
 */
const stubs = {
    DropdownMenu: {
        name: 'DropdownMenu',
        props: ['open', 'modal'],
        emits: ['update:open'],
        template: '<div><slot /></div>',
    },
    DropdownMenuTrigger: { template: '<div><slot /></div>' },
    DropdownMenuContent: {
        name: 'DropdownMenuContent',
        emits: ['animationend'],
        template: '<section v-bind="$attrs"><slot /></section>',
    },
    DropdownMenuItem: {
        emits: ['select'],
        template:
            '<button :data-key="$attrs[\'data-key\']" @click="$emit(\'select\', { preventDefault() {} })"><slot /></button>',
    },
    AppIcon: { props: ['name'], template: '<i :data-icon="name" />' },
};

const items = [
    { key: 'copy', label: 'Copy' },
    { key: 'delete', label: 'Delete', danger: true },
];

function mountMenu(props = {}) {
    return mount(ContextMenu, {
        props: { x: 10, y: 20, items, menuId: 'menu-1', ...props },
        global: { stubs },
    });
}

describe('user opens a context menu', () => {
    it('user chooses an item and its key is reported', async () => {
        const wrapper = mountMenu();

        await wrapper.findAll('button')[0]!.trigger('click');

        expect(wrapper.emitted('select')).toEqual([['copy']]);
        wrapper.unmount();
    });

    it('user chooses an item and the menu closes once', async () => {
        const wrapper = mountMenu();

        await wrapper.findAll('button')[1]!.trigger('click');

        // The caller unmounts on close, so a duplicate close would unmount twice.
        expect(wrapper.emitted('select')).toEqual([['delete']]);
        expect(wrapper.emitted('close')).toHaveLength(1);
        wrapper.unmount();
    });

    it('user dismisses the menu and it closes once', async () => {
        const wrapper = mountMenu();

        wrapper.findComponent({ name: 'DropdownMenu' }).vm.$emit('update:open', false);
        await wrapper.vm.$nextTick();

        expect(wrapper.emitted('close')).toHaveLength(1);
        wrapper.unmount();
    });

    it('user dismisses after choosing and the menu does not close twice', async () => {
        const wrapper = mountMenu();
        await wrapper.findAll('button')[0]!.trigger('click');

        wrapper.findComponent({ name: 'DropdownMenu' }).vm.$emit('update:open', false);
        await wrapper.vm.$nextTick();

        expect(wrapper.emitted('close')).toHaveLength(1);
        wrapper.unmount();
    });

    it('user gets the closed event only after the exit animation', async () => {
        const wrapper = mountMenu();
        const content = wrapper.findComponent({ name: 'DropdownMenuContent' });

        // A different animation is not this menu's exit.
        content.vm.$emit('animationend', {
            animationName: 'fade-in',
            target: {},
            currentTarget: {},
        });
        await wrapper.vm.$nextTick();
        expect(wrapper.emitted('closed')).toBeUndefined();

        // An exit animation that bubbled from a child is not the menu's own either.
        const child = {};
        content.vm.$emit('animationend', {
            animationName: 't-dropdown-out',
            target: child,
            currentTarget: {},
        });
        await wrapper.vm.$nextTick();
        expect(wrapper.emitted('closed')).toBeUndefined();

        const self = {};
        content.vm.$emit('animationend', {
            animationName: 't-dropdown-out',
            target: self,
            currentTarget: self,
        });
        await wrapper.vm.$nextTick();
        expect(wrapper.emitted('closed')).toHaveLength(1);
        wrapper.unmount();
    });

    it('user gets every item rendered with its label', () => {
        const wrapper = mountMenu();

        expect(wrapper.text()).toContain('Copy');
        expect(wrapper.text()).toContain('Delete');
        wrapper.unmount();
    });

    it('user gets the menu placed where the pointer was', () => {
        const wrapper = mountMenu({ x: 120, y: 240 });

        const trigger = wrapper.find('div.pointer-events-none');
        expect(trigger.attributes('style')).toContain('left: 120px');
        expect(trigger.attributes('style')).toContain('top: 240px');
        wrapper.unmount();
    });

    it('user gets a negative position clamped so the menu stays on screen', () => {
        const wrapper = mountMenu({ x: -40, y: -10 });

        // A menu placed off-screen would be unusable.
        const trigger = wrapper.find('div.pointer-events-none');
        expect(trigger.attributes('style')).toContain('left: 0px');
        expect(trigger.attributes('style')).toContain('top: 0px');
        wrapper.unmount();
    });

    it('user gets the menu identified by its id', () => {
        const wrapper = mountMenu({ menuId: 'menu-42' });

        expect(wrapper.find('section').attributes('data-context-menu-id')).toBe('menu-42');
        wrapper.unmount();
    });

    it('user gets an exposed close honoured', async () => {
        const wrapper = mountMenu();

        (wrapper.vm as unknown as { close: () => void }).close();
        await wrapper.vm.$nextTick();

        expect(wrapper.emitted('close')).toHaveLength(1);
        wrapper.unmount();
    });
});
