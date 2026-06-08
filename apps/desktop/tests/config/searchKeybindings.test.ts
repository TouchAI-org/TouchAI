import { describe, expect, it } from 'vitest';

import {
    createDefaultSearchKeybindings,
    getSearchKeybindingDefinition,
    isSearchKeybindingActionId,
    normalizeSearchKeybindings,
    SEARCH_KEYBINDING_ACTION_IDS,
    SEARCH_KEYBINDING_DEFINITIONS,
    type SearchKeybindingActionId,
} from '@/config/searchKeybindings';

describe('search keybinding configuration', () => {
    it('keeps action ids and definitions in sync', () => {
        expect(SEARCH_KEYBINDING_DEFINITIONS.map((definition) => definition.id)).toEqual(
            SEARCH_KEYBINDING_ACTION_IDS
        );
        expect(isSearchKeybindingActionId('search.history.open')).toBe(true);
        expect(isSearchKeybindingActionId('search.request.cancel')).toBe(false);
    });

    it('returns definitions for known actions and rejects unknown actions', () => {
        expect(getSearchKeybindingDefinition('search.window.maximize')).toMatchObject({
            id: 'search.window.maximize',
            defaultShortcut: 'F11',
            allowDisable: true,
            allowModifierlessFunctionShortcut: true,
        });

        expect(() =>
            getSearchKeybindingDefinition('search.request.cancel' as SearchKeybindingActionId)
        ).toThrow('Unknown search keybinding action: search.request.cancel');
    });

    it('creates the default keybinding map from definitions', () => {
        const defaults = createDefaultSearchKeybindings();

        expect(defaults).toEqual({
            'search.history.open': 'Mod+H',
            'search.input.focus': 'Mod+L',
            'search.session.new': 'Mod+N',
            'search.session.reopenLastClosed': 'Mod+Up',
            'search.model.toggle': 'Mod+M',
            'search.window.pin': 'Mod+P',
            'search.window.maximize': 'F11',
        });
    });

    it('normalizes persisted shortcuts and preserves disabled actions', () => {
        expect(
            normalizeSearchKeybindings({
                'search.history.open': ' ctrl + shift + h ',
                'search.input.focus': null,
                'search.session.new': '   ',
                'search.window.maximize': 'f2',
                unknown: 'Alt+U',
            })
        ).toEqual({
            ...createDefaultSearchKeybindings(),
            'search.history.open': 'Ctrl+Shift+H',
            'search.input.focus': null,
            'search.window.maximize': 'F2',
        });
    });

    it('rejects persisted shortcuts that bypass capture policy', () => {
        expect(
            normalizeSearchKeybindings({
                'search.history.open': 'H',
                'search.input.focus': 'Ctrl+L',
                'search.window.maximize': 'F12',
            })
        ).toEqual({
            ...createDefaultSearchKeybindings(),
            'search.input.focus': 'Ctrl+L',
            'search.window.maximize': 'F12',
        });
    });

    it('falls back to defaults for invalid persisted payloads', () => {
        const defaults = createDefaultSearchKeybindings();

        expect(normalizeSearchKeybindings(null)).toEqual(defaults);
        expect(normalizeSearchKeybindings(undefined)).toEqual(defaults);
        expect(normalizeSearchKeybindings('Mod+H')).toEqual(defaults);
        expect(normalizeSearchKeybindings(['Mod+H'])).toEqual(defaults);
        expect(
            normalizeSearchKeybindings({
                'search.history.open': 42,
                'search.input.focus': false,
            })
        ).toEqual(defaults);
    });
});
