import { describe, expect, it } from 'vitest';

import { messages } from '@/i18n/messages';

describe('search settings i18n', () => {
    it('labels the default search provider and AnySearch quota clearly', () => {
        expect(messages['zh-CN']['settings.search.defaultProvider']).toBe('默认供应商');
        expect(messages['zh-CN']['settings.search.provider.anysearch.quota']).toBe('免费1k/天');
        expect(messages['en-US']['settings.search.defaultProvider']).toBe('Default provider');
        expect(messages['en-US']['settings.search.provider.anysearch.quota']).toBe('Free 1k/day');
    });

    it('describes the DeepSeek provider', () => {
        // 官方中文页标的是「5元 / 每 1,000 次成功请求」，英文页是 $0.75。
        expect(messages['zh-CN']['settings.search.provider.deepseek.quota']).toBe('5 元 / 千次');
        expect(messages['en-US']['settings.search.provider.deepseek.quota']).toBe(
            '$0.75 / 1k calls'
        );
        expect(messages['zh-CN']['settings.search.provider.deepseek']).toBe('DeepSeek');
        expect(messages['en-US']['settings.search.provider.deepseek']).toBe('DeepSeek');
    });
});
