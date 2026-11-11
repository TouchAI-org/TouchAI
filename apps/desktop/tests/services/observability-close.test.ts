import { createWindowCloseHandler } from '@services/ObservabilityService';
import { vi } from 'vitest';

describe('user closes a window with pending logs', () => {
    it('user retries closing after a synchronous flush failure and the window closes', async () => {
        const flush = vi
            .fn()
            .mockImplementationOnce(() => {
                throw new Error('flush unavailable');
            })
            .mockResolvedValue(undefined);
        const closeWindow = vi.fn().mockResolvedValue(undefined);
        const handleCloseRequested = createWindowCloseHandler(closeWindow, flush);

        await handleCloseRequested({ preventDefault: vi.fn() });
        expect(closeWindow).not.toHaveBeenCalled();
        await handleCloseRequested({ preventDefault: vi.fn() });

        expect(closeWindow).toHaveBeenCalledOnce();
    });

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

    it('user gets one flush and one close when two close events overlap', async () => {
        let resolveFlush: (() => void) | undefined;
        const flush = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    resolveFlush = resolve;
                })
        );
        const closeWindow = vi.fn().mockResolvedValue(undefined);
        const handleCloseRequested = createWindowCloseHandler(closeWindow, flush);
        const firstEvent = { preventDefault: vi.fn() };
        const secondEvent = { preventDefault: vi.fn() };

        const firstClose = handleCloseRequested(firstEvent);
        const secondClose = handleCloseRequested(secondEvent);

        expect(firstEvent.preventDefault).toHaveBeenCalledOnce();
        expect(secondEvent.preventDefault).toHaveBeenCalledOnce();

        resolveFlush?.();
        await Promise.all([firstClose, secondClose]);

        expect(flush).toHaveBeenCalledOnce();
        expect(closeWindow).toHaveBeenCalledOnce();
    });
});
