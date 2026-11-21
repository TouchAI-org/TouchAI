// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

import { settleSearchSurfaceViewport } from '@/views/SearchView/searchSurfacePreparation';

const originalPlatform = navigator.platform;

function setPlatform(platform: string): void {
    Object.defineProperty(navigator, 'platform', { configurable: true, value: platform });
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
