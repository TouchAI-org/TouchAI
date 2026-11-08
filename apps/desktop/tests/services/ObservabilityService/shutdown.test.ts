// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { afterEach, describe, expect, it, vi } from 'vitest';

type CloseHandler = (event: { preventDefault: () => void }) => Promise<void>;

const { closeHandlers, closeOrder, windowMock, ingestMock, flushDoneMock, flushListener } =
    vi.hoisted(() => {
        const closeHandlers: CloseHandler[] = [];
        const closeOrder: string[] = [];

        return {
            closeHandlers,
            closeOrder,
            windowMock: {
                label: 'main',
                onCloseRequested: vi.fn(async (handler: CloseHandler) => {
                    closeHandlers.push(handler);
                    return async () => {
                        await Promise.resolve();
                        closeOrder.push('unlisten');
                    };
                }),
                close: vi.fn(async () => {
                    closeOrder.push('close');
                }),
            },
            ingestMock: vi.fn(async (): Promise<void> => {}),
            flushDoneMock: vi.fn(async (): Promise<void> => {}),
            flushListener: { handler: null as null | (() => Promise<void>) },
        };
    });

vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => windowMock,
}));

vi.mock('@services/NativeService', () => ({
    native: { observability: { ingest: ingestMock, flushDone: flushDoneMock } },
}));

vi.mock('@tauri-apps/api/event', () => ({
    listen: async (_event: string, handler: () => Promise<void>) => {
        flushListener.handler = handler;
        return () => {};
    },
}));

import { initObservability, log, resetObservabilityForTests } from '@services/ObservabilityService';

afterEach(() => {
    resetObservabilityForTests();
    vi.clearAllMocks();
    closeHandlers.length = 0;
    closeOrder.length = 0;
    flushListener.handler = null;
});

describe('user closes a window with logs still queued', () => {
    it('user gets the queued logs written before the window is closed', async () => {
        initObservability();
        log.info('last line before close');

        const handleClose = closeHandlers[0];
        const closeEvent = { preventDefault: vi.fn() };

        await handleClose?.(closeEvent);

        expect(closeEvent.preventDefault).toHaveBeenCalled();
        expect(ingestMock).toHaveBeenCalled();
        expect(windowMock.close).toHaveBeenCalled();
        expect(closeOrder).toEqual(['unlisten', 'close']);
    });

    it('user still gets the window closed when the log backend never answers', async () => {
        ingestMock.mockImplementation(() => new Promise<void>(() => {}));
        initObservability();
        log.info('stuck line');

        const handleClose = closeHandlers[0];

        await handleClose?.({ preventDefault: vi.fn() });

        expect(windowMock.close).toHaveBeenCalled();
    });

    it('user gets one flush and one close when the close button is pressed twice', async () => {
        initObservability();
        log.info('double close');

        const handleClose = closeHandlers[0];
        const firstEvent = { preventDefault: vi.fn() };
        const secondEvent = { preventDefault: vi.fn() };

        await Promise.all([handleClose?.(firstEvent), handleClose?.(secondEvent)]);

        expect(firstEvent.preventDefault).toHaveBeenCalledOnce();
        expect(secondEvent.preventDefault).toHaveBeenCalledOnce();
        expect(ingestMock).toHaveBeenCalledTimes(1);
        expect(windowMock.close).toHaveBeenCalledTimes(1);
    });

    it('user gets queued logs written when the app quits from the tray', async () => {
        ingestMock.mockImplementation(async () => {});
        initObservability();
        log.info('last line before tray quit');

        await flushListener.handler?.();

        expect(ingestMock).toHaveBeenCalled();
        expect(flushDoneMock).toHaveBeenCalledWith('main');
    });
});
