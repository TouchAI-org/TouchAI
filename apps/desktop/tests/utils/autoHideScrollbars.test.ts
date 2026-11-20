// Copyright (c) 2026. 千诚. Licensed under GPL v3.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installAutoHideScrollbars } from '@/utils/autoHideScrollbars';

describe('given native scrolling regions in an application window', () => {
    let dispose: () => void;
    let outer: HTMLDivElement;
    let inner: HTMLDivElement;

    beforeEach(() => {
        vi.useFakeTimers();
        outer = document.createElement('div');
        inner = document.createElement('div');
        outer.append(inner);
        document.body.append(outer);
        dispose = installAutoHideScrollbars(document);
    });

    afterEach(() => {
        dispose();
        outer.remove();
        vi.useRealTimers();
    });

    it('user sees no scrollbar before scrolling or when merely hovering', () => {
        inner.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
        expect(inner.hasAttribute('data-scrollbar-scrolling')).toBe(false);
        expect(outer.hasAttribute('data-scrollbar-scrolling')).toBe(false);
    });

    it('user scrolling a nested region sees only its scrollbar until the idle delay expires', () => {
        inner.dispatchEvent(new Event('scroll'));
        expect(inner.hasAttribute('data-scrollbar-scrolling')).toBe(true);
        expect(outer.hasAttribute('data-scrollbar-scrolling')).toBe(false);

        vi.advanceTimersByTime(699);
        expect(inner.hasAttribute('data-scrollbar-scrolling')).toBe(true);
        vi.advanceTimersByTime(1);
        expect(inner.hasAttribute('data-scrollbar-scrolling')).toBe(false);
    });

    it('user scrolling continuously keeps the scrollbar visible until the last movement settles', () => {
        inner.dispatchEvent(new Event('scroll'));
        vi.advanceTimersByTime(600);
        inner.dispatchEvent(new Event('scroll'));
        vi.advanceTimersByTime(600);
        expect(inner.hasAttribute('data-scrollbar-scrolling')).toBe(true);
        vi.advanceTimersByTime(100);
        expect(inner.hasAttribute('data-scrollbar-scrolling')).toBe(false);
    });

    it('user scrolling a newly opened popover sees its scrollbar without registering the container', () => {
        const popover = document.createElement('div');
        document.body.append(popover);
        try {
            popover.dispatchEvent(new Event('scroll'));
            expect(popover.hasAttribute('data-scrollbar-scrolling')).toBe(true);
            vi.advanceTimersByTime(700);
            expect(popover.hasAttribute('data-scrollbar-scrolling')).toBe(false);
        } finally {
            popover.remove();
        }
    });

    it('user scrolling separate regions gets independent visibility delays without moving their contents', () => {
        inner.scrollLeft = 120;
        outer.scrollTop = 80;
        inner.dispatchEvent(new Event('scroll'));
        vi.advanceTimersByTime(400);
        outer.dispatchEvent(new Event('scroll'));
        vi.advanceTimersByTime(300);
        expect(inner.hasAttribute('data-scrollbar-scrolling')).toBe(false);
        expect(outer.hasAttribute('data-scrollbar-scrolling')).toBe(true);
        expect(inner.scrollLeft).toBe(120);
        expect(outer.scrollTop).toBe(80);
    });

    it('user holding a visible scrollbar can finish dragging before it hides', () => {
        inner.dispatchEvent(new Event('scroll'));
        inner.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
        vi.advanceTimersByTime(1000);
        expect(inner.hasAttribute('data-scrollbar-scrolling')).toBe(true);
        document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
        vi.advanceTimersByTime(700);
        expect(inner.hasAttribute('data-scrollbar-scrolling')).toBe(false);
    });

    it('user closing the window during scrolling leaves no active scrollbars or stale listeners', () => {
        inner.dispatchEvent(new Event('scroll'));
        dispose();
        expect(inner.hasAttribute('data-scrollbar-scrolling')).toBe(false);
        inner.dispatchEvent(new Event('scroll'));
        vi.advanceTimersByTime(1000);
        expect(inner.hasAttribute('data-scrollbar-scrolling')).toBe(false);
    });
});
