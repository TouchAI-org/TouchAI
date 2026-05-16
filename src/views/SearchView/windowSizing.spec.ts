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
} from './windowSizing';

afterEach(() => {
    vi.useRealTimers();
    windowApiMock.reset();
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
            shouldEnforceIdleDefaultHeight: false,
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
            shouldEnforceIdleDefaultHeight: false,
        });
    });

    it('forces the idle default height when neither conversation nor quick search is active', () => {
        expect(
            resolveSearchWindowHeightPolicy({
                sessionCount: 0,
                quickSearchOpen: false,
            })
        ).toEqual({
            hasManagedPanel: false,
            autoResizeEnabled: false,
            respectManualOverride: false,
            allowHeightOverride: false,
            shouldEnforceIdleDefaultHeight: true,
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

describe('shouldRepairIdleSearchWindowHeight', () => {
    it('repairs idle height when manual override leaks back into the idle state', () => {
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

    it('does not repair idle height while maximized or outside the idle-ready state', () => {
        expect(
            shouldRepairIdleSearchWindowHeight({
                ready: true,
                idle: true,
                heightMode: SearchWindowHeightMode.Auto,
                maximized: true,
            })
        ).toBe(false);

        expect(
            shouldRepairIdleSearchWindowHeight({
                ready: false,
                idle: true,
                heightMode: SearchWindowHeightMode.Auto,
                maximized: false,
            })
        ).toBe(false);
    });
});

describe('shouldEnforceIdleDefaultBounds', () => {
    it('re-enforces idle bounds after leaving a managed-panel state', () => {
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

    it('does not enforce idle bounds while still managed, not ready, or maximized', () => {
        expect(
            shouldEnforceIdleDefaultBounds({
                ready: true,
                hasManagedPanel: true,
                maximized: false,
            })
        ).toBe(false);

        expect(
            shouldEnforceIdleDefaultBounds({
                ready: false,
                hasManagedPanel: false,
                maximized: false,
            })
        ).toBe(false);

        expect(
            shouldEnforceIdleDefaultBounds({
                ready: true,
                hasManagedPanel: false,
                maximized: true,
            })
        ).toBe(false);
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
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const sync = vi.fn(async () => undefined);
        sync.mockRejectedValueOnce(new Error('sync failed')).mockResolvedValueOnce(undefined);
        const scheduler = createWindowViewportSyncScheduler(sync, 0);

        scheduler.schedule();
        await Promise.resolve();
        scheduler.schedule();
        await Promise.resolve();

        expect(sync).toHaveBeenCalledTimes(2);
        expect(consoleError).toHaveBeenCalledWith(
            '[SearchView] Failed to sync viewport state:',
            expect.any(Error)
        );

        consoleError.mockRestore();
    });
});
