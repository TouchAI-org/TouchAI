import { closeTestDatabases } from '@tests/database/sqliteHarness';
import { createSettingsWindowFixture } from '@tests/utils/settingsWindow';
import { afterEach, describe, expect, it } from 'vitest';

let fixture: ReturnType<typeof createSettingsWindowFixture> | undefined;
afterEach(() => {
    fixture?.dispose();
    fixture = undefined;
    closeTestDatabases();
});

import { beforeEach } from 'vitest';

import { getLocale, setLocale } from '@/i18n';

function systemLanguage(language: string, languages = [language]) {
    Object.defineProperty(navigator, 'language', { configurable: true, value: language });
    Object.defineProperty(navigator, 'languages', { configurable: true, value: languages });
}
beforeEach(() => {
    setLocale('zh-CN');
    systemLanguage('zh-CN');
});

describe('given language preferences use the main writer', () => {
    it('user opens saved English preferences and the application uses that language without rewriting it', async () => {
        const languageWrites: string[] = [];
        fixture = createSettingsWindowFixture({
            values: { language: 'en-US' },
            query: {
                beforeQuery({ sql, params }) {
                    if (sql.startsWith('insert') && params[0] === 'language')
                        languageWrites.push(String(params[1]));
                },
            },
        });
        const store = fixture.store();
        await store.initialize();
        expect(store.settings.language).toBe('en-US');
        expect(getLocale()).toBe('en-US');
        expect(languageWrites).toEqual([]);
    });

    it('user opens preferences on a Chinese system and receives a persisted Chinese default', async () => {
        systemLanguage('zh-TW', ['zh-TW', 'en-US']);
        fixture = createSettingsWindowFixture();
        const store = fixture.store();
        await store.initialize();
        expect(store.settings.language).toBe('zh-CN');
        expect(getLocale()).toBe('zh-CN');
        expect(fixture.values.get('language')).toBe('zh-CN');
    });

    it('user opens preferences on a non-Chinese system and receives a persisted English default', async () => {
        systemLanguage('en-GB', ['en-GB', 'fr-FR']);
        fixture = createSettingsWindowFixture();
        const store = fixture.store();
        await store.initialize();
        expect(store.settings.language).toBe('en-US');
        expect(getLocale()).toBe('en-US');
        expect(fixture.values.get('language')).toBe('en-US');
    });

    it('user opens an unsupported saved language and sees Chinese without losing the original saved value', async () => {
        fixture = createSettingsWindowFixture({ values: { language: 'fr-FR' } });
        const store = fixture.store();
        await store.initialize();
        expect(store.settings.language).toBe('zh-CN');
        expect(getLocale()).toBe('zh-CN');
        expect(fixture.values.get('language')).toBe('fr-FR');
    });

    it('user changes language and the application and committed preferences agree', async () => {
        fixture = createSettingsWindowFixture();
        const store = fixture.store();
        await store.initialize();
        await store.updateLanguage('en-US');
        expect(store.settings.language).toBe('en-US');
        expect(getLocale()).toBe('en-US');
        expect(fixture.values.get('language')).toBe('en-US');
    });

    it('user changes language while storage is unavailable and keeps the prior language', async () => {
        let fail = false;
        fixture = createSettingsWindowFixture({
            values: { language: 'zh-CN' },
            query: {
                beforeQuery({ sql }) {
                    if (fail && sql.startsWith('insert')) throw new Error('database unavailable');
                },
            },
        });
        const store = fixture.store();
        await store.initialize();
        fail = true;
        await expect(store.updateLanguage('en-US')).rejects.toThrow();
        expect(store.settings.language).toBe('zh-CN');
        expect(getLocale()).toBe('zh-CN');
        expect(fixture.values.get('language')).toBe('zh-CN');
    });

    it('user changes another preference while storage is unavailable and keeps its committed value', async () => {
        let fail = false;
        fixture = createSettingsWindowFixture({
            query: {
                beforeQuery({ sql }) {
                    if (fail && sql.startsWith('insert')) throw new Error('database unavailable');
                },
            },
        });
        const store = fixture.store();
        await store.initialize();
        fail = true;
        await expect(store.updateOutputScrollBehavior('stay_position')).rejects.toThrow();
        expect(store.settings.outputScrollBehavior).toBe('follow_output');
        expect(fixture.values.get('output_scroll_behavior')).toBe('follow_output');
    });

    it('user changes language in one window and another preferences client converges', async () => {
        fixture = createSettingsWindowFixture({ values: { language: 'zh-CN' } });
        await fixture.initialize();
        const client = fixture.createClient('settings');
        await client.api.initialize();
        await fixture.owner.api.mutate('language', 'en-US');
        await import('@vue/test-utils').then(({ flushPromises }) => flushPromises());
        expect(client.api.getSnapshot().language).toBe('en-US');
    });

    it('user saves language while cross-window delivery fails and keeps the committed value with a warning', async () => {
        let failNotice = false;
        fixture = createSettingsWindowFixture({
            values: { language: 'zh-CN' },
            query: {
                aroundInvoke(call, next) {
                    const payload = call.payload as { payload?: { kind?: string; type?: string } };
                    if (
                        failNotice &&
                        call.cmd === 'plugin:event|emit' &&
                        payload?.payload?.type === 'change'
                    )
                        throw new Error('delivery unavailable');
                    return next();
                },
            },
        });
        const store = fixture.store();
        await store.initialize();
        failNotice = true;
        await store.updateLanguage('en-US');
        expect(store.settings.language).toBe('en-US');
        expect(store.lastWarning).toBeTruthy();
        expect(fixture.values.get('language')).toBe('en-US');
    });
});
