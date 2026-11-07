import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    observeSettingsWindowContentWidth,
    readSettingsWindowContentWidth,
} from '@/views/SettingsView/settingsSidebarLayout';

const originalInnerWidth = window.innerWidth;

function setViewportWidth(width: number): void {
    Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        value: width,
    });
}

afterEach(() => {
    document.querySelector('[data-testid="settings-window-shell"]')?.remove();
    setViewportWidth(originalInnerWidth);
    vi.unstubAllGlobals();
});

describe('user resizes the settings window', () => {
    it('user gets the viewport width before the window shell is mounted', () => {
        setViewportWidth(1280);

        expect(readSettingsWindowContentWidth()).toBe(1280);
    });

    it('user gets the visible shell width instead of the native window width', () => {
        const shell = document.createElement('div');
        shell.dataset.testid = 'settings-window-shell';
        shell.getBoundingClientRect = () => new DOMRect(0, 0, 1120, 700);
        document.body.append(shell);
        setViewportWidth(1168);

        expect(readSettingsWindowContentWidth()).toBe(1120);
    });

    it('user gets the viewport width when the shell has not been laid out', () => {
        const shell = document.createElement('div');
        shell.dataset.testid = 'settings-window-shell';
        shell.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
        document.body.append(shell);
        setViewportWidth(1168);

        expect(readSettingsWindowContentWidth()).toBe(1168);
    });

    it('user gets reclamped when the shell shrinks without a native resize', () => {
        let resizeCallback: (() => void) | undefined;
        const observe = vi.fn();
        const disconnect = vi.fn();

        class FakeResizeObserver {
            constructor(callback: () => void) {
                resizeCallback = callback;
            }

            observe = observe;
            disconnect = disconnect;
        }

        vi.stubGlobal('ResizeObserver', FakeResizeObserver);

        const shell = document.createElement('div');
        let visibleWidth = 968;
        shell.dataset.testid = 'settings-window-shell';
        shell.getBoundingClientRect = () => new DOMRect(0, 0, visibleWidth, 700);
        document.body.append(shell);
        const onChange = vi.fn();

        const stop = observeSettingsWindowContentWidth(onChange);
        expect(observe).toHaveBeenCalledWith(shell);

        visibleWidth = 920;
        resizeCallback?.();

        expect(onChange).toHaveBeenCalledOnce();
        stop();
        expect(disconnect).toHaveBeenCalledOnce();
    });
});
