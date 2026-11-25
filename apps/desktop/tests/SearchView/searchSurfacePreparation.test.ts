// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

import type { SearchSurfacePreparation } from '@/app/api/windows/contracts';
import {
    createSearchSurfacePreparationController,
    settleSearchSurfaceViewport,
} from '@/views/SearchView/searchSurfacePreparation';

const originalPlatform = navigator.platform;

function setPlatform(platform: string): void {
    Object.defineProperty(navigator, 'platform', { configurable: true, value: platform });
}

function preparation(showEpoch = 1): SearchSurfacePreparation {
    return {
        rendererEpoch: 1,
        showEpoch,
        hostEpoch: 1,
        source: 'shortcut',
        physicalViewport: { x: 0, y: 0, width: 750, height: 60 },
        scaleFactor: 1,
    };
}

function preparationController(
    calls: string[],
    overrides: Partial<Parameters<typeof createSearchSurfacePreparationController>[0]> = {}
) {
    return createSearchSurfacePreparationController({
        listenPrepare: async () => () => undefined,
        listenShown: async () => () => undefined,
        listenHidden: async () => () => undefined,
        getRendererEpoch: async () => 1,
        markRendererReady: async () => preparation(),
        getViewport: async () => ({
            physicalViewport: { x: 0, y: 0, width: 750, height: 60 },
            scaleFactor: 1,
        }),
        settle: async () => undefined,
        flush: async () => {
            calls.push('flush');
            return true;
        },
        onShown: async () => undefined,
        onHidden: async () => undefined,
        ...overrides,
    });
}

describe('search surface preparation', () => {
    beforeEach(() => {
        setPlatform('MacIntel');
    });

    afterEach(() => {
        setPlatform(originalPlatform);
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('user_does_not_watch_the_previous_session_close_because_it_is_dropped_before_the_surface_is_measured', async () => {
        const calls: string[] = [];
        const controller = preparationController(calls, {
            beforeMeasure: async () => {
                calls.push('beforeMeasure');
            },
            getViewport: async () => {
                calls.push('getViewport');
                return {
                    physicalViewport: { x: 0, y: 0, width: 750, height: 60 },
                    scaleFactor: 1,
                };
            },
        });

        await controller.start();

        expect(calls).toEqual(['beforeMeasure', 'getViewport', 'getViewport', 'flush']);
        controller.dispose();
    });

    it('user_does_not_get_a_reveal_when_the_surface_is_hidden_while_the_previous_session_is_dropped', async () => {
        const calls: string[] = [];
        let hide: (() => Promise<void>) | undefined;
        const controller = preparationController(calls, {
            listenHidden: async (handler) => {
                hide = async () => {
                    await handler({ reason: 'app-blur-hide', sequence: 1 });
                };
                return () => undefined;
            },
            beforeMeasure: async () => {
                calls.push('beforeMeasure');
                await hide?.();
            },
        });

        expect(await controller.start()).toBe(false);

        expect(calls).toEqual(['beforeMeasure']);
        controller.dispose();
    });

    it('user_sees_the_prepared_layout_only_after_two_frames_on_macos', async () => {
        const frames: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            frames.push(callback);
            return frames.length;
        });
        let resolved = false;
        const settlement = settleSearchSurfaceViewport().then(() => {
            resolved = true;
        });

        await nextTick();
        await Promise.resolve();
        expect(frames).toHaveLength(1);
        expect(resolved).toBe(false);

        frames.shift()?.(0);
        await Promise.resolve();
        expect(frames).toHaveLength(1);
        expect(resolved).toBe(false);

        frames.shift()?.(16);
        await settlement;
        expect(resolved).toBe(true);
    });

    it('user_is_not_blocked_when_the_parked_window_stops_delivering_frames', async () => {
        vi.useFakeTimers();
        let frame: FrameRequestCallback | undefined;
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            frame = callback;
            return 1;
        });
        let resolved = false;
        const settlement = settleSearchSurfaceViewport().then(() => {
            resolved = true;
        });

        await vi.advanceTimersByTimeAsync(47);
        expect(resolved).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        await settlement;
        expect(resolved).toBe(true);

        expect(() => {
            frame?.(64);
            frame?.(80);
        }).not.toThrow();
    });

    it('user_does_not_wait_for_a_frame_when_the_surface_is_already_visible', async () => {
        const requestFrame = vi.fn();
        vi.stubGlobal('requestAnimationFrame', requestFrame);

        await settleSearchSurfaceViewport(false);

        expect(requestFrame).not.toHaveBeenCalled();
    });

    it('user_does_not_wait_for_a_frame_on_a_platform_without_parked_windows', async () => {
        setPlatform('Win32');
        const requestFrame = vi.fn();
        vi.stubGlobal('requestAnimationFrame', requestFrame);

        await settleSearchSurfaceViewport();

        expect(requestFrame).not.toHaveBeenCalled();
    });

    it('user_still_gets_the_surface_when_the_platform_has_no_animation_frames', async () => {
        vi.stubGlobal('requestAnimationFrame', undefined);

        await expect(settleSearchSurfaceViewport()).resolves.toBeUndefined();
    });
});
