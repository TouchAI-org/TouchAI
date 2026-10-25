import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import ConfirmDialog from '@/components/ConfirmDialog.vue';

/**
 * The dialog stands between the user and a destructive action. Every close path has to report
 * exactly one result: a missing result leaves the caller waiting, and a duplicate one can run
 * the action twice.
 */
const stubs = {
    AlertDialog: {
        name: 'AlertDialog',
        props: ['open'],
        emits: ['update:open'],
        template: '<div><slot /></div>',
    },
    AlertDialogContent: {
        name: 'AlertDialogContent',
        emits: ['escape-key-down', 'pointer-down-outside', 'interact-outside', 'animationend'],
        template: '<section v-bind="$attrs"><slot /></section>',
    },
    AlertDialogHeader: { template: '<header><slot /></header>' },
    AlertDialogFooter: { template: '<footer><slot /></footer>' },
    AlertDialogTitle: { template: '<h2><slot /></h2>' },
    AlertDialogDescription: { template: '<p><slot /></p>' },
    AlertDialogAction: {
        emits: ['click'],
        template: '<button data-testid="confirm" @click="$emit(\'click\')"><slot /></button>',
    },
    AlertDialogCancel: {
        emits: ['click'],
        template: '<button data-testid="cancel" @click="$emit(\'click\')"><slot /></button>',
    },
    AppIcon: { template: '<i />' },
};

function mountDialog(props = {}) {
    return mount(ConfirmDialog, {
        props: { message: 'Delete this?', ...props },
        global: { stubs },
    });
}

describe('user answers a confirmation', () => {
    it('user confirms and the confirm event fires once', async () => {
        const wrapper = mountDialog();

        await wrapper.find('[data-testid="confirm"]').trigger('click');

        expect(wrapper.emitted('confirm')).toHaveLength(1);
        expect(wrapper.emitted('cancel')).toBeUndefined();
        wrapper.unmount();
    });

    it('user cancels and the cancel event fires once', async () => {
        const wrapper = mountDialog();

        await wrapper.find('[data-testid="cancel"]').trigger('click');

        expect(wrapper.emitted('cancel')).toHaveLength(1);
        expect(wrapper.emitted('confirm')).toBeUndefined();
        wrapper.unmount();
    });

    it('user presses escape and the dialog cancels', async () => {
        const wrapper = mountDialog();

        wrapper.findComponent({ name: 'AlertDialogContent' }).vm.$emit('escape-key-down');

        expect(wrapper.emitted('cancel')).toHaveLength(1);
        wrapper.unmount();
    });

    it('user clicks outside and the dialog cancels', async () => {
        const wrapper = mountDialog();

        wrapper.findComponent({ name: 'AlertDialogContent' }).vm.$emit('pointer-down-outside');

        expect(wrapper.emitted('cancel')).toHaveLength(1);
        wrapper.unmount();
    });

    it('user gets only one result after confirming and then cancelling', async () => {
        const wrapper = mountDialog();

        await wrapper.find('[data-testid="confirm"]').trigger('click');
        wrapper.findComponent({ name: 'AlertDialogContent' }).vm.$emit('escape-key-down');

        // A second result would let the caller run both branches of its decision.
        expect(wrapper.emitted('confirm')).toHaveLength(1);
        expect(wrapper.emitted('cancel')).toBeUndefined();
        wrapper.unmount();
    });

    it('user gets a cancelled result when the host closes the dialog', async () => {
        const wrapper = mountDialog({ open: true });

        await wrapper.setProps({ open: false });

        expect(wrapper.emitted('cancel')).toHaveLength(1);
        wrapper.unmount();
    });

    it('user gets the dialog usable again when the host reopens it', async () => {
        const wrapper = mountDialog({ open: true });
        await wrapper.setProps({ open: false });
        await wrapper.setProps({ open: true });

        await wrapper.find('[data-testid="confirm"]').trigger('click');

        // Reopening must clear the previous result, or the second answer is swallowed.
        expect(wrapper.emitted('confirm')).toHaveLength(1);
        wrapper.unmount();
    });

    it('user gets the closed event only after the exit animation finishes', async () => {
        const wrapper = mountDialog();
        const content = wrapper.findComponent({ name: 'AlertDialogContent' });

        // The handler only reports the exit animation when it started on the dialog itself.
        // A different animation name, or one that bubbled from a child, must not count.
        content.vm.$emit('animationend', {
            animationName: 'fade-in',
            target: {},
            currentTarget: {},
        });
        await wrapper.vm.$nextTick();
        expect(wrapper.emitted('closed')).toBeUndefined();

        const child = {};
        content.vm.$emit('animationend', {
            animationName: 't-modal-out',
            target: child,
            currentTarget: {},
        });
        await wrapper.vm.$nextTick();
        expect(wrapper.emitted('closed')).toBeUndefined();

        const same = {};
        content.vm.$emit('animationend', {
            animationName: 't-modal-out',
            target: same,
            currentTarget: same,
        });
        await wrapper.vm.$nextTick();
        expect(wrapper.emitted('closed')).toHaveLength(1);
        wrapper.unmount();
    });

    it('user gets no closed event for an unrelated animation', async () => {
        const wrapper = mountDialog();

        const content = wrapper.findComponent({ name: 'AlertDialogContent' });
        const event = new Event('animationend') as AnimationEvent;
        Object.defineProperty(event, 'animationName', { value: 'fade-in' });
        content.element.dispatchEvent(event);
        await wrapper.vm.$nextTick();

        expect(wrapper.emitted('closed')).toBeUndefined();
        wrapper.unmount();
    });

    it('user sees the message and the buttons they were given', () => {
        const wrapper = mountDialog({
            title: 'Delete file',
            message: 'This cannot be undone',
            confirmText: 'Delete',
            cancelText: 'Keep',
        });

        expect(wrapper.text()).toContain('This cannot be undone');
        expect(wrapper.text()).toContain('Delete file');
        expect(wrapper.text()).toContain('Delete');
        expect(wrapper.text()).toContain('Keep');
        wrapper.unmount();
    });

    it('user gets the dialog marked closed when the host says so', () => {
        const wrapper = mountDialog({ open: false });

        // The stub always renders its slot, so the contract is the open flag handed to it.
        expect(wrapper.findComponent({ name: 'AlertDialog' }).props('open')).toBe(false);
        wrapper.unmount();
    });
});
