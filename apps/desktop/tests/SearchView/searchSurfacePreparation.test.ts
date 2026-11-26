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
            return 'committed' as const;
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
        let approveClear!: () => void;
        const controller = preparationController(calls, {
            beforeMeasure: () =>
                new Promise<void>((resolve) => {
                    calls.push('beforeMeasure');
                    approveClear = resolve;
                }),
            getViewport: async () => {
                calls.push('getViewport');
                return {
                    physicalViewport: { x: 0, y: 0, width: 750, height: 60 },
                    scaleFactor: 1,
                };
            },
        });

        const starting = controller.start();
        // Nothing may be measured or committed while the clear is still running.
        for (let index = 0; index < 20; index += 1) await Promise.resolve();
        expect(calls).toEqual(['beforeMeasure']);

        approveClear();
        await expect(starting).resolves.toBe(true);
        expect(calls).toEqual(['beforeMeasure', 'getViewport', 'getViewport', 'flush']);
        controller.dispose();
    });

    it('user_does_not_get_a_reveal_when_the_surface_is_hidden_while_the_previous_session_is_dropped', async () => {
        const calls: string[] = [];
        let hide: (() => Promise<void>) | undefined;
        let finishClear!: () => void;
        const controller = preparationController(calls, {
            listenHidden: async (handler) => {
                hide = async () => {
                    await handler({ reason: 'app-blur-hide', sequence: 1 });
                };
                return () => undefined;
            },
            beforeMeasure: () =>
                new Promise<void>((resolve) => {
                    calls.push('beforeMeasure');
                    finishClear = resolve;
                }),
        });

        const starting = controller.start();
        for (let index = 0; index < 20; index += 1) await Promise.resolve();
        // The surface hides while the clear is still running, so the clear that
        // finishes afterwards must not reach a commit.
        await hide?.();
        finishClear();

        await expect(starting).resolves.toBe(false);
        expect(calls).toEqual(['beforeMeasure']);
        controller.dispose();
    });

    it('user_gets_a_fresh_preparation_when_the_host_resized_while_it_was_hidden', async () => {
        const calls: string[] = [];
        let prepare: ((payload: SearchSurfacePreparation) => void | Promise<void>) | undefined;
        const resized: SearchSurfacePreparation = {
            ...preparation(),
            hostEpoch: 2,
            physicalViewport: { x: 0, y: 0, width: 750, height: 240 },
        };
        const controller = preparationController(calls, {
            listenPrepare: async (handler) => {
                prepare = handler;
                return () => undefined;
            },
            getViewport: async () => ({
                physicalViewport: { x: 0, y: 0, width: 750, height: 240 },
                scaleFactor: 1,
            }),
            beforeMeasure: async () => {
                calls.push('beforeMeasure');
            },
            requestHostRefresh: async () => {
                calls.push('refresh');
                await prepare?.(resized);
            },
            onError: (error) => {
                calls.push(`error:${(error as Error).message}`);
            },
        });

        expect(await controller.start()).toBe(true);

        expect(calls).toEqual(['beforeMeasure', 'refresh', 'beforeMeasure', 'flush']);
        controller.dispose();
    });

    it('user_gets_an_error_instead_of_a_stalled_reveal_when_the_refresh_fails_during_a_retry', async () => {
        const calls: string[] = [];
        let failRefresh!: (error: Error) => void;
        const controller = preparationController(calls, {
            // The measured frame never matches the preparation, so the host is
            // asked for a fresh one and the answer is still outstanding.
            getViewport: async () => ({
                physicalViewport: { x: 0, y: 0, width: 750, height: 240 },
                scaleFactor: 1,
            }),
            requestHostRefresh: () =>
                new Promise<void>((_resolve, reject) => {
                    calls.push('refresh');
                    failRefresh = reject;
                }),
            onError: (error) => {
                calls.push(`error:${(error as Error).message}`);
            },
        });

        const starting = controller.start();
        for (let index = 0; index < 20; index += 1) await Promise.resolve();
        expect(calls).toEqual(['refresh']);

        // A viewport notification retries while the refresh is in flight. That
        // retry cannot ask for another refresh, so the failing one must still
        // end the show instead of leaving it pending.
        controller.notifyViewportChanged();
        for (let index = 0; index < 20; index += 1) await Promise.resolve();

        failRefresh(new Error('host refresh failed'));
        await expect(starting).resolves.toBe(false);
        expect(calls).toEqual(['refresh', 'error:host refresh failed']);
        controller.dispose();
    });

    it('user_gets_no_error_and_no_retry_when_the_host_already_replaced_the_preparation', async () => {
        const calls: string[] = [];
        const controller = preparationController(calls, {
            flush: async () => {
                calls.push('flush');
                return 'superseded' as const;
            },
            onError: (error) => {
                calls.push(`error:${(error as Error).message}`);
            },
        });

        await expect(controller.start()).resolves.toBe(false);

        expect(calls).toEqual(['flush']);
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
