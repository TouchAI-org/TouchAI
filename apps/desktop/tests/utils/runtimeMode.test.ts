import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getRuntimeInfoMock } = vi.hoisted(() => ({
    getRuntimeInfoMock: vi.fn(),
}));

vi.mock('@services/NativeService', () => ({
    native: {
        runtime: {
            getRuntimeInfo: getRuntimeInfoMock,
        },
    },
}));

describe('user gets the normal runtime unless the backend reports an e2e run', () => {
    beforeEach(() => {
        vi.resetModules();
        getRuntimeInfoMock.mockReset();
    });

    it('user gets normal mode when the runtime information cannot be read', async () => {
        getRuntimeInfoMock.mockRejectedValue(new Error('ipc unavailable'));
        const { isE2eTestMode } = await import('@/utils/runtimeMode');

        await expect(isE2eTestMode()).resolves.toBe(false);
    });

    it('user gets e2e mode when the backend reports it', async () => {
        getRuntimeInfoMock.mockResolvedValue({ isE2eTestMode: true });
        const { isE2eTestMode } = await import('@/utils/runtimeMode');

        await expect(isE2eTestMode()).resolves.toBe(true);
    });
});
