import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The alert helpers are called from places that have no component instance (services, error
 * handlers, the bootstrap code), so they have to mount their own host. Getting this wrong means
 * a toast that never appears or a second host appended on every call.
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

    it('user gets a success alert forwarded to the host', () => {
        const alert = useAlert();
        const instance = mountMock.mock.results[0]!.value as Record<
            string,
            ReturnType<typeof vi.fn>
        >;

        alert.success('Saved', 3_000);

        expect(instance.success).toHaveBeenCalledWith('Saved', 3_000);
    });

    it('user gets an error alert forwarded to the host', () => {
        const alert = useAlert();
        const instance = mountMock.mock.results[0]!.value as Record<
            string,
            ReturnType<typeof vi.fn>
        >;

        alert.error('Failed');

        expect(instance.error).toHaveBeenCalledWith('Failed', undefined);
    });

    it('user gets a warning alert forwarded to the host', () => {
        const alert = useAlert();
        const instance = mountMock.mock.results[0]!.value as Record<
            string,
            ReturnType<typeof vi.fn>
        >;

        alert.warning('Careful');

        expect(instance.warning).toHaveBeenCalledWith('Careful', undefined);
    });

    it('user gets an info alert forwarded to the host', () => {
        const alert = useAlert();
        const instance = mountMock.mock.results[0]!.value as Record<
            string,
            ReturnType<typeof vi.fn>
        >;

        alert.info('Heads up');

        expect(instance.info).toHaveBeenCalledWith('Heads up', undefined);
    });

    it('user gets one host however many times alerts are used', () => {
        const first = useAlert();
        const second = useAlert();

        // A second mount would stack duplicate toasts on top of each other.
        expect(mountMock).toHaveBeenCalledTimes(1);
        expect(document.querySelectorAll('#alert-container')).toHaveLength(1);
        expect(typeof first.success).toBe('function');
        expect(typeof second.success).toBe('function');
    });
});
