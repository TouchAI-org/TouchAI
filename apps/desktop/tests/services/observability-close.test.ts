import { createWindowCloseHandler } from '@services/ObservabilityService';
import { vi } from 'vitest';

describe('user closes a window with pending logs', () => {
    it('user gets the window closed after the pending logs flush', async () => {
        const flush = vi.fn().mockResolvedValue(undefined);
        const closeWindow = vi.fn().mockResolvedValue(undefined);
        const handleCloseRequested = createWindowCloseHandler(closeWindow, flush);
        const closeEvent = { preventDefault: vi.fn() };

        await handleCloseRequested(closeEvent);

        expect(closeEvent.preventDefault).toHaveBeenCalledOnce();
        expect(flush).toHaveBeenCalledOnce();
        expect(closeWindow).toHaveBeenCalledOnce();

        const nativeFollowUp = { preventDefault: vi.fn() };
        await handleCloseRequested(nativeFollowUp);

        expect(nativeFollowUp.preventDefault).not.toHaveBeenCalled();
    });

    it('user can retry closing when the window close call fails', async () => {
        const flush = vi.fn().mockResolvedValue(undefined);
        const closeWindow = vi
            .fn()
            .mockRejectedValueOnce(new Error('window is not ready'))
            .mockResolvedValueOnce(undefined);
        const handleCloseRequested = createWindowCloseHandler(closeWindow, flush);

        await handleCloseRequested({ preventDefault: vi.fn() });
        const retryEvent = { preventDefault: vi.fn() };
        await handleCloseRequested(retryEvent);

        expect(retryEvent.preventDefault).toHaveBeenCalledOnce();
        expect(closeWindow).toHaveBeenCalledTimes(2);
    });
});
