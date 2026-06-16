import { describe, expect, it } from 'vitest';

import { messages } from '@/i18n/messages';

describe('search settings i18n', () => {
    it('labels the default search provider and AnySearch quota clearly', () => {
        expect(messages['zh-CN']['settings.search.defaultProvider']).toBe('默认供应商');
        expect(messages['zh-CN']['settings.search.provider.anysearch.quota']).toBe('每日 1000 次');
        expect(messages['en-US']['settings.search.defaultProvider']).toBe('Default provider');
        expect(messages['en-US']['settings.search.provider.anysearch.quota']).toBe('1,000/day');
    });
});
