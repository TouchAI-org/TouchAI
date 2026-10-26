import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The alert helpers are called from places that have no component instance (services, error
 * handlers, the bootstrap code), so they have to mount their own host. Getting this wrong means
 * a toast that never appears, or a second host appended on every call.
 *
 * Forwarding each level to the host is already covered against the real component in
 * tests/components/alertMessage.test.ts, so this file only guards the host lifecycle.
 */
const { mountMock } = vi.hoisted(() => ({
    mountMock: vi.fn(() => ({
        success: vi.fn(),
        error: vi.fn(),
        warning: vi.fn(),
        info: vi.fn(),
    })),
}));

vi.mock('vue', async () => {
    const actual = await vi.importActual<typeof import('vue')>('vue');
    return {
        ...actual,
        createApp: vi.fn(() => ({ mount: mountMock })),
    };
});

vi.mock('@components/AlertMessage.vue', () => ({ default: { name: 'AlertMessage' } }));

let useAlert: typeof import('@/composables/useAlert').useAlert;

beforeEach(async () => {
    // The host is a module-level singleton, so each test needs a fresh module registry or the
    // first test's mount leaks into the rest.
    vi.resetModules();
    ({ useAlert } = await import('@/composables/useAlert'));
});

afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
});

describe('user gets an alert from code that has no component', () => {
    it('user gets the alert host mounted on the page', () => {
        useAlert();

        // The host is what makes a toast visible at all.
        expect(document.getElementById('alert-container')).not.toBeNull();
        expect(mountMock).toHaveBeenCalled();
    });

    it('user gets the alert text and duration they passed reaching the host', () => {
        const alert = useAlert();
        const instance = mountMock.mock.results[0]!.value as Record<
            string,
            ReturnType<typeof vi.fn>
        >;

        alert.error('Could not save', 5_000);

        // The message and the dwell time are what the user actually experiences.
        expect(instance.error).toHaveBeenCalledWith('Could not save', 5_000);
    });

    it('user gets one host however many times alerts are used', () => {
        useAlert();
        useAlert();

        // A second mount would stack duplicate toasts on top of each other.
        expect(mountMock).toHaveBeenCalledTimes(1);
        expect(document.querySelectorAll('#alert-container')).toHaveLength(1);
    });
});
