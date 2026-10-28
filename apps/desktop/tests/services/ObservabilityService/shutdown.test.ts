// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { afterEach, describe, expect, it, vi } from 'vitest';

const { windowMock, ingestMock } = vi.hoisted(() => ({
    windowMock: {
        label: 'main',
        onCloseRequested: vi.fn(),
        destroy: vi.fn(async () => undefined),
    },
    ingestMock: vi.fn(async () => undefined),
}));

vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => windowMock,
}));

vi.mock('@services/NativeService', () => ({
    native: { observability: { ingest: ingestMock } },
}));

import { initObservability, log, resetObservabilityForTests } from '@services/ObservabilityService';

afterEach(() => {
    resetObservabilityForTests();
    vi.clearAllMocks();
});

describe('user closes a window with logs still queued', () => {
    it('user gets the queued logs written before the window is destroyed', async () => {
        initObservability();
        log.info('last line before close');

        const handleClose = windowMock.onCloseRequested.mock.calls[0]?.[0] as
            | ((event: { preventDefault: () => void }) => Promise<void>)
            | undefined;
        const closeEvent = { preventDefault: vi.fn() };

        await handleClose?.(closeEvent);

        expect(closeEvent.preventDefault).toHaveBeenCalled();
        expect(ingestMock).toHaveBeenCalled();
        expect(windowMock.destroy).toHaveBeenCalled();
    });

    it('user still gets the window closed when the log backend never answers', async () => {
        ingestMock.mockImplementation(() => new Promise<void>(() => {}));
        initObservability();
        log.info('stuck line');

        const handleClose = windowMock.onCloseRequested.mock.calls[0]?.[0] as
            | ((event: { preventDefault: () => void }) => Promise<void>)
            | undefined;

        await handleClose?.({ preventDefault: vi.fn() });

        expect(windowMock.destroy).toHaveBeenCalled();
    });
});
