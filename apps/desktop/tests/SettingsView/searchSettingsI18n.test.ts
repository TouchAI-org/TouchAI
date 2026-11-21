import { describe, expect, it } from 'vitest';

import { messages } from '@/i18n/messages';

describe('user reads the search settings', () => {
    it('user sees the default provider and optional key requirement in both languages', () => {
        expect(messages['zh-CN']['settings.search.defaultProvider']).toBe('默认供应商');
        expect(messages['zh-CN']['settings.search.provider.anysearch.quota']).toBe('可选 Key');
        expect(messages['en-US']['settings.search.defaultProvider']).toBe('Default provider');
        expect(messages['en-US']['settings.search.provider.anysearch.quota']).toBe('Optional key');
    });

    it('user describes the DeepSeek provider', () => {
        expect(messages['zh-CN']['settings.search.provider.deepseek.quota']).toBe('需 Key');
        expect(messages['en-US']['settings.search.provider.deepseek.quota']).toBe('Key required');
        expect(messages['zh-CN']['settings.search.provider.deepseek']).toBe('DeepSeek');
        expect(messages['en-US']['settings.search.provider.deepseek']).toBe('DeepSeek');
    });
});
