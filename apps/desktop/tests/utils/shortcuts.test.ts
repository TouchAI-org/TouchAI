import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    captureShortcutFromKeyboardEvent,
    findShortcutConflict,
    formatShortcutForDisplay,
    hasCommandModifier,
    hasRequiredModifier,
    isModifierlessFunctionShortcut,
    isReservedGlobalShortcut,
    isReservedLocalShortcut,
    isReservedLocalShortcutKey,
    matchShortcut,
    normalizeLocalShortcutString,
    resolveKeyboardEventShortcutKey,
    toCurrentPlatformShortcut,
} from '@/utils/shortcuts';

const originalPlatform = navigator.platform;

function setPlatform(platform: string) {
    Object.defineProperty(window.navigator, 'platform', {
        configurable: true,
        value: platform,
    });
}

describe('shortcut utilities', () => {
    beforeEach(() => {
        setPlatform('Win32');
    });

    afterEach(() => {
        setPlatform(originalPlatform);
    });

    it('normalizes shortcut strings with aliases and stable modifier ordering', () => {
        expect(normalizeLocalShortcutString('mod+h')).toBe('Mod+H');
        expect(normalizeLocalShortcutString(' shift + cmd + option + k ')).toBe('Mod+Alt+Shift+K');
        expect(normalizeLocalShortcutString('control+delete')).toBe('Mod+Del');
        expect(normalizeLocalShortcutString('return')).toBe('Enter');
        expect(normalizeLocalShortcutString('tab')).toBe('Tab');
        expect(normalizeLocalShortcutString('insert')).toBe('Insert');
        expect(normalizeLocalShortcutString('F01')).toBe('F1');
        expect(normalizeLocalShortcutString('Ctrl+F09')).toBe('Mod+F9');
        expect(normalizeLocalShortcutString('f12')).toBe('F12');
        expect(normalizeLocalShortcutString(null)).toBeNull();
        expect(normalizeLocalShortcutString('Ctrl+Alt')).toBeNull();
        expect(normalizeLocalShortcutString('Ctrl+A+B')).toBeNull();
        expect(normalizeLocalShortcutString('Ctrl+DefinitelyNotAKey')).toBeNull();
        expect(normalizeLocalShortcutString('Ctrl+DefinitelyNotAKey+A')).toBeNull();
        expect(normalizeLocalShortcutString('Ctrl++A')).toBeNull();
        expect(normalizeLocalShortcutString('Ctrl+@')).toBeNull();
        expect(normalizeLocalShortcutString('F13')).toBeNull();
        expect(normalizeLocalShortcutString('F25')).toBeNull();
        expect(normalizeLocalShortcutString('   ')).toBeNull();

        setPlatform('MacIntel');

        expect(normalizeLocalShortcutString('control+delete')).toBe('Ctrl+Del');
    });

    it('formats display shortcuts for the current platform', () => {
        expect(formatShortcutForDisplay('Mod+Shift+H')).toBe('Ctrl+Shift+H');
        expect(toCurrentPlatformShortcut('Mod+H')).toBe('Ctrl+H');
        expect(toCurrentPlatformShortcut('')).toBeNull();
        expect(formatShortcutForDisplay(null)).toBeTruthy();

        setPlatform('MacIntel');

        expect(formatShortcutForDisplay('Mod+Ctrl+Alt+Shift+H')).toBe('Cmd+Ctrl+Option+Shift+H');
        expect(formatShortcutForDisplay('Alt+Space')).toBe('Option+Space');
        expect(toCurrentPlatformShortcut('Mod+H')).toBe('Cmd+H');
    });

    it('resolves keyboard event keys from display key aliases and function-row codes', () => {
        expect(resolveKeyboardEventShortcutKey('ArrowUp')).toBe('Up');
        expect(resolveKeyboardEventShortcutKey(' ', null)).toBe('Space');
        expect(resolveKeyboardEventShortcutKey('BrightnessUp', 'F2')).toBe('F2');
        expect(resolveKeyboardEventShortcutKey('F2', 'F3')).toBe('F2');
        expect(resolveKeyboardEventShortcutKey('!', 'Digit1')).toBe('1');
        expect(resolveKeyboardEventShortcutKey('@', 'Digit2')).toBe('2');
        expect(resolveKeyboardEventShortcutKey('<', 'Comma')).toBe(',');
        expect(resolveKeyboardEventShortcutKey('?', 'Slash')).toBe('/');
        expect(resolveKeyboardEventShortcutKey('+', 'Equal')).toBe('=');
        expect(resolveKeyboardEventShortcutKey('BrightnessUp', 'F25')).toBeNull();
        expect(resolveKeyboardEventShortcutKey('BrightnessUp', 'F13')).toBeNull();
        expect(resolveKeyboardEventShortcutKey('@')).toBeNull();
        expect(resolveKeyboardEventShortcutKey('x', 'Space')).toBe('X');
        expect(resolveKeyboardEventShortcutKey('BrightnessUp', 'Space')).toBeNull();
        expect(resolveKeyboardEventShortcutKey('', 'KeyA')).toBeNull();
        expect(resolveKeyboardEventShortcutKey(undefined, undefined)).toBeNull();
    });

    it('matches shortcuts using platform-specific Mod behavior', () => {
        expect(matchShortcut('Mod+H', { key: 'h', ctrlKey: true })).toBe(true);
        expect(matchShortcut('Mod+H', { key: 'h', metaKey: true })).toBe(false);
        expect(matchShortcut('Ctrl+H', { key: 'h', ctrlKey: true })).toBe(true);
        expect(matchShortcut('Ctrl+H', { key: 'h' })).toBe(false);
        expect(
            matchShortcut('Alt+Shift+Del', { key: 'Delete', altKey: true, shiftKey: true })
        ).toBe(true);
        expect(
            matchShortcut('Mod+Shift+1', {
                key: '!',
                code: 'Digit1',
                ctrlKey: true,
                shiftKey: true,
            })
        ).toBe(true);
        expect(
            matchShortcut('Mod+Shift+,', {
                key: '<',
                code: 'Comma',
                ctrlKey: true,
                shiftKey: true,
            })
        ).toBe(true);
        expect(matchShortcut('Alt+Shift+Del', { key: 'Delete', altKey: true })).toBe(false);
        expect(matchShortcut(null, { key: 'h' })).toBe(false);
        expect(matchShortcut('Mod+H', { key: 'x', ctrlKey: true })).toBe(false);

        setPlatform('MacIntel');

        expect(matchShortcut('Mod+H', { key: 'h', metaKey: true })).toBe(true);
        expect(matchShortcut('Mod+H', { key: 'h', ctrlKey: true })).toBe(false);
        expect(matchShortcut('Mod+Ctrl+H', { key: 'h', metaKey: true, ctrlKey: true })).toBe(true);
    });

    it('captures shortcuts from keyboard events and ignores unsupported key presses', () => {
        expect(
            captureShortcutFromKeyboardEvent(new KeyboardEvent('keydown', { key: 'Control' }))
        ).toBeNull();
        expect(
            captureShortcutFromKeyboardEvent(
                new KeyboardEvent('keydown', { key: 'k', metaKey: true })
            )
        ).toBeNull();

        expect(
            captureShortcutFromKeyboardEvent(
                new KeyboardEvent('keydown', {
                    key: 'BrightnessUp',
                    code: 'F2',
                    ctrlKey: true,
                    altKey: true,
                    shiftKey: true,
                })
            )
        ).toEqual({
            shortcut: 'Mod+Alt+Shift+F2',
            displayShortcut: 'Ctrl+Alt+Shift+F2',
        });
        expect(
            captureShortcutFromKeyboardEvent(
                new KeyboardEvent('keydown', {
                    key: '!',
                    code: 'Digit1',
                    ctrlKey: true,
                    shiftKey: true,
                })
            )
        ).toEqual({
            shortcut: 'Mod+Shift+1',
            displayShortcut: 'Ctrl+Shift+1',
        });

        setPlatform('MacIntel');

        expect(
            captureShortcutFromKeyboardEvent(
                new KeyboardEvent('keydown', {
                    key: 'k',
                    metaKey: true,
                    ctrlKey: true,
                    altKey: true,
                    shiftKey: true,
                })
            )
        ).toEqual({
            shortcut: 'Mod+Ctrl+Alt+Shift+K',
            displayShortcut: 'Cmd+Ctrl+Option+Shift+K',
        });
    });

    it('classifies reserved, modifierless, and conflicting shortcuts', () => {
        expect(isReservedLocalShortcut('Enter')).toBe(true);
        expect(isReservedLocalShortcut('Mod+Backspace')).toBe(true);
        expect(isReservedLocalShortcut('Ctrl+Delete')).toBe(true);
        expect(isReservedLocalShortcut('Alt+Home')).toBe(true);
        expect(isReservedLocalShortcut('Shift+End')).toBe(true);
        expect(isReservedLocalShortcut('Mod+PageUp')).toBe(true);
        expect(isReservedLocalShortcut('Mod+PageDown')).toBe(true);
        expect(isReservedLocalShortcut('Mod+K')).toBe(false);
        expect(isReservedLocalShortcut(null)).toBe(false);
        expect(isReservedLocalShortcutKey('ArrowDown')).toBe(true);
        expect(isReservedLocalShortcutKey('BrightnessUp', 'F2')).toBe(false);

        expect(hasRequiredModifier('Mod+K')).toBe(true);
        expect(hasRequiredModifier('Shift+K')).toBe(true);
        expect(hasRequiredModifier('F11')).toBe(false);
        expect(hasRequiredModifier('')).toBe(false);

        expect(hasCommandModifier('Mod+K')).toBe(true);
        expect(hasCommandModifier('Alt+Shift+K')).toBe(true);
        expect(hasCommandModifier('Shift+K')).toBe(false);
        expect(hasCommandModifier('F11')).toBe(false);

        expect(isModifierlessFunctionShortcut('F1')).toBe(true);
        expect(isModifierlessFunctionShortcut('F12')).toBe(true);
        expect(isModifierlessFunctionShortcut('F13')).toBe(false);
        expect(isModifierlessFunctionShortcut('Mod+F1')).toBe(false);
        expect(isModifierlessFunctionShortcut(null)).toBe(false);

        const entries = [
            { id: 'history', shortcut: 'Mod+H' },
            { id: 'new-session', shortcut: 'Mod+N' },
            { id: 'disabled', shortcut: null },
        ];

        expect(findShortcutConflict('cmd+h', entries)).toBe('history');
        expect(findShortcutConflict('Mod+H', entries, 'history')).toBeNull();
        expect(findShortcutConflict('Mod+P', entries)).toBeNull();
        expect(findShortcutConflict('', entries)).toBeNull();
    });

    it('classifies macOS system global shortcut conflicts', () => {
        expect(isReservedGlobalShortcut('Mod+Space')).toBe(false);
        expect(isReservedGlobalShortcut('Ctrl+Space')).toBe(false);

        setPlatform('MacIntel');

        expect(isReservedGlobalShortcut('Cmd+Space')).toBe(true);
        expect(isReservedGlobalShortcut('Mod+Space')).toBe(true);
        expect(isReservedGlobalShortcut('Ctrl+Space')).toBe(true);
        expect(isReservedGlobalShortcut('Option+Space')).toBe(false);
        expect(isReservedGlobalShortcut('Option+Shift+Space')).toBe(false);
    });
});
