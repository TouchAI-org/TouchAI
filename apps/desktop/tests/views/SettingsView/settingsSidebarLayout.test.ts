import { afterEach, describe, expect, it } from 'vitest';

import { readSettingsWindowContentWidth } from '@/views/SettingsView/settingsSidebarLayout';

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
});
