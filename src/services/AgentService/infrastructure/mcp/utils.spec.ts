import { describe, expect, it, vi } from 'vitest';

vi.mock('@/services/AgentService/infrastructure/attachments', () => ({
    base64ToUint8Array: vi.fn(),
    createPersistedAttachmentFromData: vi.fn(),
}));

import { raceWithTimeoutAndSignal } from './utils';

describe('raceWithTimeoutAndSignal', () => {
    it('rejects an already-aborted signal even when timeout is disabled', async () => {
        const controller = new AbortController();
        controller.abort();

        await expect(
            raceWithTimeoutAndSignal(Promise.resolve('completed'), 0, controller.signal)
        ).rejects.toThrow('Request cancelled');
    });

    it('returns the original promise when no timeout or signal is configured', async () => {
        await expect(raceWithTimeoutAndSignal(Promise.resolve('completed'), 0)).resolves.toBe(
            'completed'
        );
    });
});
