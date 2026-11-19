import { closeTestDatabases } from '@tests/database/sqliteHarness';
import { createSettingsWindowFixture } from '@tests/utils/settingsWindow';
import { afterEach, describe, expect, it } from 'vitest';

let fixture: ReturnType<typeof createSettingsWindowFixture> | undefined;
afterEach(() => {
    fixture?.dispose();
    fixture = undefined;
    closeTestDatabases();
});

import { createDefaultSearchKeybindings } from '@/config/searchKeybindings';

describe('given the main writer owns saved search shortcuts', () => {
    it('user opens preferences with no saved shortcuts and receives persisted defaults', async () => {
        fixture = createSettingsWindowFixture();
        const store = fixture.store();
        await store.initialize();
        expect(store.settings.searchKeybindings).toEqual(createDefaultSearchKeybindings());
        expect(store.settings.searchKeybindings['search.window.maximize']).toBe('F11');
        expect(store.settings.searchKeybindings['search.settings.open']).toBe('Mod+,');
        expect(JSON.parse(fixture.values.get('search_keybindings')!)).toEqual(
            createDefaultSearchKeybindings()
        );
    });

    it('user keeps preferences usable after a default write fails and can save a later choice', async () => {
        let fail = true;
        fixture = createSettingsWindowFixture({
            query: {
                beforeQuery({ sql, params }) {
                    if (fail && sql.startsWith('insert') && params[0] === 'search_keybindings')
                        throw new Error('database locked');
                },
            },
        });
        const store = fixture.store();
        await store.initialize();
        expect(store.initialized).toBe(true);
        expect(store.settings.searchKeybindings).toEqual(createDefaultSearchKeybindings());
        expect(fixture.values.get('search_keybindings')).toBeUndefined();
        fail = false;
        await store.updateSearchKeybindings({
            ...store.settings.searchKeybindings,
            'search.input.focus': 'Mod+K',
        });
        expect(JSON.parse(fixture.values.get('search_keybindings')!)).toMatchObject({
            'search.input.focus': 'Mod+K',
        });
    });

    it('user opens legacy shortcuts and keeps their valid choice while missing defaults merge', async () => {
        fixture = createSettingsWindowFixture({
            values: {
                search_keybindings: JSON.stringify({
                    'search.history.open': 'Mod+Y',
                    'search.request.cancel': null,
                    'search.draft.clearAll': 'Mod+Backspace',
                }),
            },
        });
        const store = fixture.store();
        await store.initialize();
        const expected = { ...createDefaultSearchKeybindings(), 'search.history.open': 'Mod+Y' };
        expect(store.settings.searchKeybindings).toEqual(expected);
        expect(JSON.parse(fixture.values.get('search_keybindings')!)).toEqual(expected);
    });

    it('user changes a shortcut and receives the same committed value in preferences and storage', async () => {
        fixture = createSettingsWindowFixture();
        const store = fixture.store();
        await store.initialize();
        const next = { ...createDefaultSearchKeybindings(), 'search.input.focus': 'Mod+K' };
        await store.updateSearchKeybindings(next);
        expect(store.settings.searchKeybindings).toEqual(next);
        expect(JSON.parse(fixture.values.get('search_keybindings')!)).toEqual(next);
    });
});
