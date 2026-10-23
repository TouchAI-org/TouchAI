import { afterEach, describe, expect, it, vi } from 'vitest';

import { SearchWindowHeightMode } from '@/config/searchWindow';

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

vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => windowApiMock.currentWindow,
}));

import {
    createWindowViewportSyncScheduler,
    ensureWindowMaximized,
    ensureWindowRestoredFromMaximized,
    resolveEffectiveWindowMaximized,
    resolveSearchWindowDefaultSizeApplyAction,
    resolveSearchWindowHeightPolicy,
    resolveSearchWindowMinimumSize,
    shouldEnforceIdleDefaultBounds,
    shouldFillConversationAvailableHeight,
    shouldRemeasureAfterMaximizedRestore,
    shouldRepairIdleSearchWindowHeight,
} from '@/views/SearchView/windowSizing';

afterEach(() => {
    vi.useRealTimers();
    windowApiMock.reset();
});

describe('when the search window has no conversation on screen', () => {
    it('user gets a window locked to the default height that still follows the search bar', () => {
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
            shouldEnforceIdleDefaultHeight: true,
        });
    });

    it('user gets a fixed min and max height so the idle window cannot be resized by hand', () => {
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

    it('user gets the default size restored instead of a stale panel measurement', () => {
        expect(
            resolveSearchWindowDefaultSizeApplyAction({
                ready: true,
                maximized: false,
                hasManagedPanel: false,
            })
        ).toBe('reset_idle_bounds');
    });
});

describe('when a conversation is on screen', () => {
    it('user gets a window that follows the content and remembers a manual height', () => {
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
            shouldEnforceIdleDefaultHeight: false,
        });
    });

    it('user can shrink the window no further than the auto-height floor', () => {
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

    it('user gets the panel measured again after the default size is restored', () => {
        expect(
            resolveSearchWindowDefaultSizeApplyAction({
                ready: true,
                maximized: false,
                hasManagedPanel: true,
            })
        ).toBe('reset_and_remeasure_managed_panel');
    });

    it('user sees the conversation fill the window when maximized or holding a manual height', () => {
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
    });
});

describe('when the quick search panel is open with no conversation', () => {
    it('user gets the window following the panel but not remembering a manual height', () => {
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
            shouldEnforceIdleDefaultHeight: false,
        });
    });
});

describe('when the window is not ready or is maximized', () => {
    it('user gets no size change until the window is ready again', () => {
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

    it('user gets no idle-height repair while maximized', () => {
        expect(
            shouldRepairIdleSearchWindowHeight({
                ready: true,
                idle: true,
                heightMode: SearchWindowHeightMode.Auto,
                maximized: true,
            })
        ).toBe(false);
    });

    it('user gets no idle bounds re-applied while maximized', () => {
        expect(
            shouldEnforceIdleDefaultBounds({
                ready: true,
                hasManagedPanel: false,
                maximized: true,
            })
        ).toBe(false);
    });
});

describe('when the window returns from a conversation to the idle state', () => {
    it('user gets the idle height repaired when a manual height leaked out of the conversation', () => {
        expect(
            shouldRepairIdleSearchWindowHeight(
                {
                    ready: true,
                    idle: true,
                    heightMode: SearchWindowHeightMode.ManualOverride,
                    maximized: false,
                },
                {
                    ready: true,
                    idle: true,
                    heightMode: SearchWindowHeightMode.Auto,
                    maximized: false,
                }
            )
        ).toBe(true);
    });

    it('user gets the idle height left alone while the window is still starting up', () => {
        expect(
            shouldRepairIdleSearchWindowHeight({
                ready: false,
                idle: true,
                heightMode: SearchWindowHeightMode.Auto,
                maximized: false,
            })
        ).toBe(false);
    });

    it('user gets the default bounds re-applied when the conversation closes', () => {
        expect(
            shouldEnforceIdleDefaultBounds(
                {
                    ready: true,
                    hasManagedPanel: false,
                    maximized: false,
                },
                {
                    ready: true,
                    hasManagedPanel: true,
                    maximized: false,
                }
            )
        ).toBe(true);
    });

    it('user gets no bounds change while a panel is still on screen', () => {
        expect(
            shouldEnforceIdleDefaultBounds({
                ready: true,
                hasManagedPanel: true,
                maximized: false,
            })
        ).toBe(false);
    });
});

describe('when the window is transitioning between maximized and restored', () => {
    it('user gets the conversation treated as maximized for the whole transition', () => {
        expect(resolveEffectiveWindowMaximized(false, true)).toBe(true);
        expect(resolveEffectiveWindowMaximized(true, false)).toBe(true);
        expect(resolveEffectiveWindowMaximized(false, false)).toBe(false);
    });

    it('user gets the conversation remeasured only after a real restore', () => {
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

    it('user gets no remeasure when no conversation is on screen', () => {
        expect(
            shouldRemeasureAfterMaximizedRestore({
                wasMaximized: true,
                isMaximized: false,
                hasManagedPanel: false,
            })
        ).toBe(false);

        expect(
            shouldFillConversationAvailableHeight({
                hasConversationPanel: false,
                isMaximized: true,
                shouldRespectManualHeightOverride: true,
            })
        ).toBe(false);
    });
});

describe('when the app restores the window from maximized', () => {
    it('user gets an immediate confirmation when the window is already restored', async () => {
        const window = {
            isMaximized: vi.fn().mockResolvedValue(false),
            maximize: vi.fn(),
            unmaximize: vi.fn(),
        };

        await expect(ensureWindowRestoredFromMaximized(window)).resolves.toBe(true);

        expect(window.unmaximize).not.toHaveBeenCalled();
        expect(windowApiMock.currentWindow.onResized).not.toHaveBeenCalled();
    });

    it('user gets the restore confirmed only after the window animation settles', async () => {
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

    it('user gets the maximize reported as failed when the window never settles', async () => {
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

describe('when the window viewport keeps changing', () => {
    it('user gets one sync immediately and the rest coalesced into a single trailing sync', async () => {
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

    it('user gets no trailing sync after the scheduler is disposed', () => {
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

    it('user gets further syncs after one of them failed', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const sync = vi.fn(async () => undefined);
        sync.mockRejectedValueOnce(new Error('sync failed')).mockResolvedValueOnce(undefined);
        const scheduler = createWindowViewportSyncScheduler(sync, 0);

        scheduler.schedule();
        await Promise.resolve();
        scheduler.schedule();
        await Promise.resolve();

        expect(sync).toHaveBeenCalledTimes(2);
    });
});
