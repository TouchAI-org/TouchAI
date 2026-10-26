import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick } from 'vue';

vi.mock('@components/ConfirmDialog.vue', async () => {
    const { defineComponent: component, h: render } = await import('vue');
    return {
        default: component({
            props: { message: { type: String, required: true } },
            emits: ['confirm', 'cancel', 'closed'],
            setup(_props, { emit, expose }) {
                expose({
                    finishClose: () => emit('closed'),
                });
                return () =>
                    render('div', { 'data-testid': 'confirm-dialog' }, [
                        render('button', {
                            'data-action': 'confirm',
                            onClick: () => emit('confirm'),
                        }),
                        render('button', {
                            'data-action': 'cancel',
                            onClick: () => emit('cancel'),
                        }),
                        render('button', { 'data-action': 'close', onClick: () => emit('closed') }),
                    ]);
            },
        }),
    };
});

import { useConfirm } from '@/composables/useConfirm';

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

type ConfirmApi = ReturnType<typeof useConfirm>;

function mountConfirm() {
    const Harness = defineComponent({
        setup(_, { expose }) {
            expose(useConfirm());
            return () => h('div');
        },
    });
    const wrapper = mount(Harness, { attachTo: document.body });
    return { wrapper, api: wrapper.vm as unknown as ConfirmApi };
}

describe('user answers a confirmation dialog', () => {
    it('user resolves immediately on confirm and disposes after exit completion', async () => {
        const { wrapper, api } = mountConfirm();
        const promise = api.confirm({ message: 'Proceed?' });
        const container = document.querySelector('[data-testid="confirm-dialog"]')?.parentElement;

        await document.querySelector<HTMLButtonElement>('[data-action="confirm"]')?.click();
        await expect(promise).resolves.toBe(true);
        expect(container?.isConnected).toBe(true);

        await document.querySelector<HTMLButtonElement>('[data-action="close"]')?.click();
        await nextTick();
        expect(container?.isConnected).toBe(false);
        wrapper.unmount();
    });

    it('user settles replaced requests as cancelled and resolves an active request on scope disposal', async () => {
        const { wrapper, api } = mountConfirm();
        const first = api.confirm({ message: 'First?' });
        const second = api.confirm({ message: 'Second?' });

        await expect(first).resolves.toBe(false);
        wrapper.unmount();
        await expect(second).resolves.toBe(false);
        expect(document.querySelector('[data-testid="confirm-dialog"]')).toBeNull();
    });
});

describe('user dismisses a confirmation dialog', () => {
    it('user gets the cancel answer reported when they press cancel', async () => {
        const { wrapper, api } = mountConfirm();

        const pending = api.confirm({ message: 'Delete this?' });
        await nextTick();

        const cancel = document.querySelector('[data-action="cancel"]') as HTMLButtonElement;
        cancel.click();
        await nextTick();

        // Cancel is an answer, not a hang: the caller gets false and can carry on.
        await expect(pending).resolves.toBe(false);

        wrapper.unmount();
    });
});
