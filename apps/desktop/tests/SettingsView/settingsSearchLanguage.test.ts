import { afterEach, describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';
import { searchSettings } from '@/views/SettingsView/settingsSearch';

/**
 * The settings search is a navigation aid, not a translation lookup. Someone reading the
 * Chinese interface may still know a setting by its English name, and someone reading the
 * English one may have learned it in Chinese, so a query must match either way. The row
 * that comes back is always rendered in the active language.
 */
describe('user searches the settings in the interface language', () => {
    afterEach(() => {
        setLocale('zh-CN');
    });

    it('user finds a setting by the words shown on screen', () => {
        setLocale('zh-CN');

        const results = searchSettings('开机');

        expect(results.length).toBeGreaterThan(0);
        expect(results.some((result) => result.id === 'general:settings.general.startOnBoot')).toBe(
            true
        );
    });
});

describe('user searches the settings in another language', () => {
    afterEach(() => {
        setLocale('zh-CN');
    });

    it('user finds the start-minimized setting by its English name while reading Chinese', () => {
        setLocale('zh-CN');

        const results = searchSettings('minimized');

        expect(
            results.some((result) => result.id === 'general:settings.general.startMinimized')
        ).toBe(true);
    });

    it('user still sees the row in the active language, not the searched one', () => {
        setLocale('zh-CN');

        const result = searchSettings('minimized').find(
            (entry) => entry.id === 'general:settings.general.startMinimized'
        );

        expect(result).toBeTruthy();
        // The label comes from the Chinese dictionary even though the query was English.
        expect(result!.label).not.toMatch(/minimiz/i);
    });

    it('user finds a Chinese-named setting by its Chinese words while reading English', () => {
        setLocale('en-US');

        const results = searchSettings('开机');

        expect(results.some((result) => result.id === 'general:settings.general.startOnBoot')).toBe(
            true
        );
    });

    it('user gets no results for a word that appears in no translation', () => {
        setLocale('zh-CN');

        expect(searchSettings('zzzznotasetting')).toEqual([]);
    });

    it('user gets nothing for an empty query', () => {
        expect(searchSettings('   ')).toEqual([]);
    });
});

describe('user searches settings by the section they belong to', () => {
    afterEach(() => {
        setLocale('zh-CN');
    });

    it('user finds the settings that live in a matching section', () => {
        setLocale('zh-CN');

        const sectionLabel = searchSettings('浏览器').find(
            (result) => result.section === 'browser'
        );

        expect(sectionLabel).toBeTruthy();
    });

    it('user gets the best match first', () => {
        setLocale('zh-CN');

        const results = searchSettings('启动');

        expect(results.length).toBeGreaterThan(1);
        // A label hit outranks a description or section hit.
        expect(results[0]!.label).toContain('启动');
    });
});
