import { describe, expect, it, vi } from 'vitest';

import {
    DEFAULT_LOCALE,
    getLocale,
    i18n,
    installI18n,
    isSupportedLocale,
    locale,
    normalizeLocale,
    resolveFirstLaunchLocale,
    setLocale,
    t,
    tp,
    tt,
} from '@/i18n';
import { messages } from '@/i18n/messages';
import { hasTextTranslation } from '@/i18n/textMap';

describe('i18n runtime', () => {
    it('keeps locale message dictionaries complete', () => {
        const zhKeys = Object.keys(messages['zh-CN']).sort();
        const enKeys = Object.keys(messages['en-US']).sort();

        expect(enKeys).toEqual(zhKeys);
    });

    it('normalizes unsupported locales to the default locale', () => {
        expect(DEFAULT_LOCALE).toBe('zh-CN');
        expect(isSupportedLocale('en-US')).toBe(true);
        expect(isSupportedLocale('fr-FR')).toBe(false);
        expect(normalizeLocale('fr-FR')).toBe('zh-CN');
        expect(normalizeLocale(null)).toBe('zh-CN');
    });

    it('maps first-launch system locales to the supported app locales', () => {
        Object.defineProperty(window.navigator, 'language', {
            configurable: true,
            value: 'en-GB',
        });
        Object.defineProperty(window.navigator, 'languages', {
            configurable: true,
            value: ['en-GB', 'fr-FR'],
        });

        expect(resolveFirstLaunchLocale()).toBe('en-US');
        expect(resolveFirstLaunchLocale({ language: 'zh-CN' })).toBe('zh-CN');
        expect(resolveFirstLaunchLocale({ language: 'zh-TW' })).toBe('zh-CN');
        expect(resolveFirstLaunchLocale({ language: 'en-GB' })).toBe('en-US');
        expect(resolveFirstLaunchLocale({ language: 'fr-FR', languages: ['zh-HK', 'en-US'] })).toBe(
            'zh-CN'
        );
    });

    it('translates structured messages and interpolates params', () => {
        setLocale('en-US');

        expect(t('settings.general.title')).toBe('General settings');
        expect(t('common.saved')).toBe('Saved');
        expect(t('common.count', { count: 3 })).toBe('3 items');
    });

    it('uses vue-i18n pluralization for keyed messages', () => {
        setLocale('en-US');

        expect(tp('settings.ai.modelSearchPlaceholder', 1)).toBe('Search 1 model...');
        expect(tp('settings.ai.modelSearchPlaceholder', 2)).toBe('Search 2 models...');

        setLocale('zh-CN');
        expect(tp('settings.ai.modelSearchPlaceholder', 2)).toBe('搜索2个模型...');
    });

    it('keeps keyed vue-i18n messages separate from the legacy source-text bridge', () => {
        setLocale('en-US');

        expect(i18n.mode).toBe('composition');
        expect(i18n.global.locale.value).toBe('en-US');
        expect(locale.value).toBe('en-US');
        expect(getLocale()).toBe('en-US');
        expect(i18n.global.t('settings.general.title')).toBe(t('settings.general.title'));
        expect(i18n.global.t('settings.builtInTools.summary.bash')).toBe(
            'Execute terminal commands'
        );
        expect(i18n.global.te('settings.general.title')).toBe(true);
        expect(i18n.global.te('设置')).toBe(false);
    });

    it('translates exact Chinese UI text and preserves unknown text', () => {
        setLocale('en-US');

        expect(hasTextTranslation('设置')).toBe(true);
        expect(hasTextTranslation('不存在的产品文案')).toBe(false);
        expect(tt('设置')).toBe('Settings');
        expect(tt('刷新成功，新增 {count} 个模型', { count: 2 })).toBe(
            'Refresh complete, added 2 models'
        );
        expect(tt('不存在的产品文案')).toBe('不存在的产品文案');
    });

    it('switches back to Chinese and preserves interpolation', () => {
        setLocale('en-US');
        expect(t('settings.language.changed', { language: 'English' })).toBe(
            'Language changed to English'
        );

        setLocale('zh-CN');
        expect(t('settings.language.changed', { language: '简体中文' })).toBe(
            '语言已切换为简体中文'
        );
    });

    it('updates document language when setting the locale', () => {
        document.documentElement.lang = '';

        expect(setLocale('en-US')).toBe('en-US');
        expect(document.documentElement.lang).toBe('en-US');

        expect(setLocale('unsupported')).toBe('zh-CN');
        expect(document.documentElement.lang).toBe('zh-CN');
    });

    it('installs vue-i18n and the $tt compatibility global property', () => {
        const app = {
            config: {
                globalProperties: {},
            },
            use: vi.fn(),
        };

        installI18n(app as unknown as Parameters<typeof installI18n>[0]);

        expect(app.use).toHaveBeenCalledWith(i18n);
        expect(app.config.globalProperties).toMatchObject({
            $tt: tt,
        });
        expect(app.config.globalProperties).not.toHaveProperty('$t');
    });
});
