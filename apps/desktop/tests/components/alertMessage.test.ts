import { enableAutoUnmount, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import AlertMessage from '@/components/AlertMessage.vue';

/*
 * AlertMessage is the app's only toast entry point. Two things a caller depends
 * on: each status reaches the matching vue-sonner method with the message and the
 * duration, and only one mounted instance owns the <Sonner/> renderer so toasts
 * are not drawn twice. Both are observable — one through the toast calls, the
 * other through the rendered markup.
 */

const toast = vi.hoisted(() => ({
    success: vi.fn(() => 'toast-1'),
    error: vi.fn(() => 'toast-2'),
    warning: vi.fn(() => 'toast-3'),
    info: vi.fn(() => 'toast-4'),
    dismiss: vi.fn(),
}));

vi.mock('vue-sonner', () => ({ toast }));

vi.mock('@components/ui/sonner', () => ({
    Sonner: {
        name: 'UiSonner',
        template: '<div data-testid="sonner" />',
    },
}));

type AlertApi = {
    show: (type: string, message: string, duration?: number) => string | number;
    close: (id: string | number) => void;
    success: (message: string, duration?: number) => string | number;
    error: (message: string, duration?: number) => string | number;
    warning: (message: string, duration?: number) => string | number;
    info: (message: string, duration?: number) => string | number;
};

function mountAlert() {
    const wrapper = mount(AlertMessage);
    return { wrapper, api: wrapper.vm as unknown as AlertApi };
}

// The renderer ownership is module-level state, so every mounted host has to be
// torn down or the next test would start with the claim still held.
enableAutoUnmount(afterEach);

beforeEach(() => {
    vi.clearAllMocks();
    toast.success.mockReturnValue('toast-1');
    toast.error.mockReturnValue('toast-2');
    toast.warning.mockReturnValue('toast-3');
    toast.info.mockReturnValue('toast-4');
});

describe('user is shown a notification', () => {
    it('user sees a success toast with the message they were given', () => {
        const { api } = mountAlert();

        api.success('Saved');

        expect(toast.success).toHaveBeenCalledWith('Saved', { duration: 3000 });
    });

    it('user sees an error toast with the message they were given', () => {
        const { api } = mountAlert();

        api.error('Save failed');

        expect(toast.error).toHaveBeenCalledWith('Save failed', { duration: 3000 });
    });

    it('user sees a warning toast with the message they were given', () => {
        const { api } = mountAlert();

        api.warning('Not saved yet');

        expect(toast.warning).toHaveBeenCalledWith('Not saved yet', { duration: 3000 });
    });

    it('user sees an info toast with the message they were given', () => {
        const { api } = mountAlert();

        api.info('Nothing to do');

        expect(toast.info).toHaveBeenCalledWith('Nothing to do', { duration: 3000 });
    });

    it('user gets the default three seconds when the caller names no duration', () => {
        const { api } = mountAlert();

        api.show('success', 'Hi');

        expect(toast.success).toHaveBeenCalledWith('Hi', { duration: 3000 });
    });

    it('user gets the duration the caller asked for', () => {
        const { api } = mountAlert();

        api.error('Sticky', 10_000);

        expect(toast.error).toHaveBeenCalledWith('Sticky', { duration: 10_000 });
    });

    it('user gets the toast id back so it can be closed later', () => {
        const { api } = mountAlert();

        expect(api.success('Saved')).toBe('toast-1');
    });

    it('user sees the toast dismissed when the caller closes it', () => {
        const { api } = mountAlert();

        api.close('toast-1');

        expect(toast.dismiss).toHaveBeenCalledWith('toast-1');
    });
});

describe('user runs two notification hosts', () => {
    it('user gets exactly one toast renderer while one host is mounted', () => {
        const { wrapper } = mountAlert();

        expect(wrapper.findAll('[data-testid="sonner"]')).toHaveLength(1);
    });

    it('user gets no second renderer while a second host is mounted', () => {
        const first = mountAlert();
        const second = mountAlert();

        expect(first.wrapper.findAll('[data-testid="sonner"]')).toHaveLength(1);
        expect(second.wrapper.findAll('[data-testid="sonner"]')).toHaveLength(0);
    });

    it('user gets the renderer back when the owning host is replaced', () => {
        const first = mountAlert();
        expect(first.wrapper.findAll('[data-testid="sonner"]')).toHaveLength(1);

        first.wrapper.unmount();

        const replacement = mountAlert();
        expect(replacement.wrapper.findAll('[data-testid="sonner"]')).toHaveLength(1);
    });

    it('user still gets one renderer when a non-owning host is torn down first', () => {
        const first = mountAlert();
        const second = mountAlert();
        expect(second.wrapper.findAll('[data-testid="sonner"]')).toHaveLength(0);

        second.wrapper.unmount();

        expect(first.wrapper.findAll('[data-testid="sonner"]')).toHaveLength(1);
    });

    it('user keeps the renderer owned by the host that claimed it first', () => {
        const first = mountAlert();
        const second = mountAlert();

        // A later host never steals the claim, so tearing it down cannot leave the
        // app without a renderer.
        second.wrapper.unmount();
        const third = mountAlert();

        expect(first.wrapper.findAll('[data-testid="sonner"]')).toHaveLength(1);
        expect(third.wrapper.findAll('[data-testid="sonner"]')).toHaveLength(0);
    });
});
