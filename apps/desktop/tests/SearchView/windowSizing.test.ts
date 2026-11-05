import { afterEach, describe, expect, it, vi } from 'vitest';

const windowApiMock = vi.hoisted(() => {
    let resizeListener: (() => void) | null = null;
    const unlisten = vi.fn();
    const currentWindow = {
        onResized: vi.fn((listener: () => void) => {
            resizeListener = listener;
            return Promise.resolve(unlisten);
        }),
        isMaximized: vi.fn(),
    };

    return {
        currentWindow,
        emitResize: () => resizeListener?.(),
        reset: () => {
            resizeListener = null;
            unlisten.mockReset();
            currentWindow.onResized.mockClear();
            currentWindow.isMaximized.mockReset();
        },
        unlisten,
    };
});

const observabilityMock = vi.hoisted(() => ({
    error: vi.fn(),
}));

vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => windowApiMock.currentWindow,
}));

vi.mock('@services/ObservabilityService', () => ({
    log: observabilityMock,
}));

import {
    createWindowViewportSyncScheduler,
    ensureWindowMaximized,
    ensureWindowRestoredFromMaximized,
    resolveAutoSessionPanelHeight,
    resolveEffectiveWindowMaximized,
    resolveSearchWindowDefaultSizeApplyAction,
    resolveSearchWindowHeightPolicy,
    resolveSearchWindowMeasuredHeight,
    resolveSearchWindowMinimumSize,
    shouldFillConversationAvailableHeight,
    shouldRemeasureAfterMaximizedRestore,
} from '@/views/SearchView/windowSizing';

afterEach(() => {
    vi.useRealTimers();
    windowApiMock.reset();
});

describe('resolveSearchWindowMeasuredHeight', () => {
    it('prefers the natural overlay requirement over a clamped bottom edge for a bounded host', () => {
        expect(
            resolveSearchWindowMeasuredHeight({
                panelHeight: 120,
                overlayBottom: 160,
                overlayRequiredViewportHeight: 260,
                monitorHost: false,
            })
        ).toBe(260);
    });

    it('keeps monitor-host panel height independent from overlay geometry', () => {
        expect(
            resolveSearchWindowMeasuredHeight({
                panelHeight: 120,
                overlayBottom: 260,
                overlayRequiredViewportHeight: 340,
                monitorHost: true,
            })
        ).toBe(120);
    });

    it('returns to the natural panel height after overlay measurements are cleared', () => {
        expect(
            resolveSearchWindowMeasuredHeight({
                panelHeight: 120,
                overlayBottom: null,
                overlayRequiredViewportHeight: null,
                monitorHost: false,
            })
        ).toBe(120);
    });
});

describe('resolveAutoSessionPanelHeight', () => {
    it('adds the conversation auto cap to the current search bar height', () => {
        expect(
            resolveAutoSessionPanelHeight({
                searchBarHeight: 60,
            })
        ).toBe(660);
        expect(
            resolveAutoSessionPanelHeight({
                searchBarHeight: 72,
                conversationMaxHeight: 600,
            })
        ).toBe(672);
    });
});

describe('resolveSearchWindowHeightPolicy', () => {
    it('enables auto resize and manual override only when a conversation panel exists', () => {
        expect(
            resolveSearchWindowHeightPolicy({
                sessionCount: 1,
                quickSearchOpen: false,
            })
        ).toEqual({
            hasManagedPanel: true,
            autoResizeEnabled: true,
            respectManualOverride: true,
            allowHeightOverride: true,
        });

        expect(
            resolveSearchWindowHeightPolicy({
                sessionCount: 0,
                quickSearchOpen: true,
            })
        ).toEqual({
            hasManagedPanel: true,
            autoResizeEnabled: true,
            respectManualOverride: false,
            allowHeightOverride: false,
        });
    });

    it('keeps idle windows on the default height while still allowing content-driven auto resize', () => {
        expect(
            resolveSearchWindowHeightPolicy({
                sessionCount: 0,
                quickSearchOpen: false,
            })
        ).toEqual({
            hasManagedPanel: false,
            autoResizeEnabled: true,
            respectManualOverride: false,
            allowHeightOverride: false,
        });
    });
});

describe('resolveSearchWindowDefaultSizeApplyAction', () => {
    it('skips default-size application while the window is not ready or still maximized', () => {
        expect(
            resolveSearchWindowDefaultSizeApplyAction({
                ready: false,
                maximized: false,
                hasManagedPanel: true,
            })
        ).toBe('skip');

        expect(
            resolveSearchWindowDefaultSizeApplyAction({
                ready: true,
                maximized: true,
                hasManagedPanel: false,
            })
        ).toBe('skip');
    });

    it('remeasures managed panels but only resets idle windows', () => {
        expect(
            resolveSearchWindowDefaultSizeApplyAction({
                ready: true,
                maximized: false,
                hasManagedPanel: true,
            })
        ).toBe('reset_and_remeasure_managed_panel');

        expect(
            resolveSearchWindowDefaultSizeApplyAction({
                ready: true,
                maximized: false,
                hasManagedPanel: false,
            })
        ).toBe('reset_idle_bounds');
    });
});

describe('resolveSearchWindowMinimumSize', () => {
    it('uses the larger of the default height and auto-height floor when a panel is managed', () => {
        expect(
            resolveSearchWindowMinimumSize({
                defaultWidth: 750,
                defaultHeight: 60,
                hasManagedPanel: true,
                autoHeightFloor: 180,
            })
        ).toEqual({
            minWidth: 750,
            minHeight: 180,
            maxHeight: null,
        });
    });

    it('locks idle windows to the default height', () => {
        expect(
            resolveSearchWindowMinimumSize({
                defaultWidth: 750,
                defaultHeight: 60,
                hasManagedPanel: false,
                autoHeightFloor: 180,
            })
        ).toEqual({
            minWidth: 750,
            minHeight: 60,
            maxHeight: 60,
        });
    });
});

describe('layout policy helpers', () => {
    it('fills the conversation height only for maximized or manual-override conversation layouts', () => {
        expect(
            shouldFillConversationAvailableHeight({
                hasConversationPanel: true,
                isMaximized: true,
                shouldRespectManualHeightOverride: false,
            })
        ).toBe(true);

        expect(
            shouldFillConversationAvailableHeight({
                hasConversationPanel: true,
                isMaximized: false,
                shouldRespectManualHeightOverride: true,
            })
        ).toBe(true);

        expect(
            shouldFillConversationAvailableHeight({
                hasConversationPanel: true,
                isMaximized: false,
                shouldRespectManualHeightOverride: true,
                isIntrinsicHeightMeasurementPending: true,
            } as Parameters<typeof shouldFillConversationAvailableHeight>[0])
        ).toBe(false);

        expect(
            shouldFillConversationAvailableHeight({
                hasConversationPanel: true,
                isMaximized: true,
                shouldRespectManualHeightOverride: false,
                isIntrinsicHeightMeasurementPending: true,
            } as Parameters<typeof shouldFillConversationAvailableHeight>[0])
        ).toBe(true);

        expect(
            shouldFillConversationAvailableHeight({
                hasConversationPanel: false,
                isMaximized: true,
                shouldRespectManualHeightOverride: true,
            })
        ).toBe(false);
    });

    it('treats maximize transitions as maximized and remeasures only after restoring managed panels', () => {
        expect(resolveEffectiveWindowMaximized(false, true)).toBe(true);
        expect(
            shouldRemeasureAfterMaximizedRestore({
                wasMaximized: true,
                isMaximized: false,
                hasManagedPanel: true,
            })
        ).toBe(true);
        expect(
            shouldRemeasureAfterMaximizedRestore({
                wasMaximized: false,
                isMaximized: false,
                hasManagedPanel: true,
            })
        ).toBe(false);
    });
});

describe('window maximize helpers', () => {
    it('returns immediately when the window is already restored from maximized state', async () => {
        const window = {
            isMaximized: vi.fn().mockResolvedValue(false),
            maximize: vi.fn(),
            unmaximize: vi.fn(),
        };

        await expect(ensureWindowRestoredFromMaximized(window)).resolves.toBe(true);

        expect(window.unmaximize).not.toHaveBeenCalled();
        expect(windowApiMock.currentWindow.onResized).not.toHaveBeenCalled();
    });

    it('waits for the resize stream to settle before confirming a maximized window was restored', async () => {
        vi.useFakeTimers();
        const window = {
            isMaximized: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
            maximize: vi.fn(),
            unmaximize: vi.fn().mockResolvedValue(undefined),
        };
        windowApiMock.currentWindow.isMaximized.mockResolvedValue(false);

        const restorePromise = ensureWindowRestoredFromMaximized(window);
        await Promise.resolve();
        await Promise.resolve();

        expect(window.unmaximize).toHaveBeenCalledTimes(1);

        windowApiMock.emitResize();
        vi.advanceTimersByTime(49);
        await Promise.resolve();
        expect(windowApiMock.unlisten).not.toHaveBeenCalled();

        vi.advanceTimersByTime(1);
        await expect(restorePromise).resolves.toBe(true);
        expect(windowApiMock.unlisten).toHaveBeenCalledTimes(1);
    });

    it('times out maximize confirmation when the window never emits a stabilized resize event', async () => {
        vi.useFakeTimers();
        const window = {
            isMaximized: vi.fn().mockResolvedValue(false),
            maximize: vi.fn().mockResolvedValue(undefined),
            unmaximize: vi.fn(),
        };

        const maximizePromise = ensureWindowMaximized(window);
        await Promise.resolve();
        await Promise.resolve();

        expect(window.maximize).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(200);
        await expect(maximizePromise).resolves.toBe(false);
        expect(windowApiMock.unlisten).toHaveBeenCalledTimes(1);
    });
});

describe('createWindowViewportSyncScheduler', () => {
    it('runs immediately the first time and coalesces repeated schedules inside the throttle window', async () => {
        vi.useFakeTimers();
        const sync = vi.fn().mockResolvedValue(undefined);
        const scheduler = createWindowViewportSyncScheduler(sync, 100);

        scheduler.schedule();
        scheduler.schedule();
        scheduler.schedule();

        expect(sync).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(99);
        expect(sync).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(1);
        await Promise.resolve();

        expect(sync).toHaveBeenCalledTimes(2);
        vi.useRealTimers();
    });

    it('cancels the trailing sync when the scheduler is disposed before the throttle window ends', () => {
        vi.useFakeTimers();
        const sync = vi.fn().mockResolvedValue(undefined);
        const scheduler = createWindowViewportSyncScheduler(sync, 100);

        scheduler.schedule();
        scheduler.schedule();
        scheduler.cancel();
        vi.advanceTimersByTime(100);

        expect(sync).toHaveBeenCalledTimes(1);
        vi.useRealTimers();
    });

    it('swallows sync failures so later scheduling can continue', async () => {
        const sync = vi.fn(async () => undefined);
        sync.mockRejectedValueOnce(new Error('sync failed')).mockResolvedValueOnce(undefined);
        const scheduler = createWindowViewportSyncScheduler(sync, 0);

        scheduler.schedule();
        await Promise.resolve();
        scheduler.schedule();
        await Promise.resolve();

        expect(sync).toHaveBeenCalledTimes(2);
        expect(observabilityMock.error).toHaveBeenCalledWith(
            '[SearchView] Failed to sync viewport state:',
            expect.any(Error)
        );
    });
});
