import { describe, expect, it, vi } from 'vitest';

import { SearchWindowHeightMode } from '@/config/searchWindow';

import {
    createWindowViewportSyncScheduler,
    resolveEffectiveWindowMaximized,
    resolveSearchWindowDefaultSizeApplyAction,
    resolveSearchWindowHeightPolicy,
    resolveSearchWindowMinimumSize,
    shouldEnforceIdleDefaultBounds,
    shouldFillConversationAvailableHeight,
    shouldRemeasureAfterMaximizedRestore,
    shouldRepairIdleSearchWindowHeight,
} from './windowSizing';

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
});
