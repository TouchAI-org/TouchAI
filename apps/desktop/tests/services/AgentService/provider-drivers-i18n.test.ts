import { beforeEach, describe, expect, it } from 'vitest';

import type { ProviderDriver } from '@/database/schema';
import { setLocale } from '@/i18n';
import {
    createProviderFromRegistry,
    getProviderDriverDefinition,
    getProviderDriverDefinitions,
    isProviderDriver,
    parseProviderDriver,
    providerDriverDefinitions,
} from '@/services/AgentService/infrastructure/providers';

describe('provider driver labels i18n', () => {
    beforeEach(() => {
        setLocale('zh-CN');
    });

    it('localizes app-owned provider driver labels for English UI', () => {
        setLocale('en-US');

        expect(getProviderDriverDefinition('openai-compatible').label).toBe('OpenAI compatible');
        expect(getProviderDriverDefinition('anthropic-compatible').label).toBe(
            'Anthropic compatible'
        );
        expect(getProviderDriverDefinition('alibaba').label).toBe('Alibaba Cloud Bailian');
        expect(getProviderDriverDefinition('zhipu').label).toBe('Zhipu');
    });

    it('keeps provider driver labels in Chinese for the default locale', () => {
        const labels = getProviderDriverDefinitions().map((definition) => definition.label);

        expect(labels).toContain('OpenAI 兼容');
        expect(labels).toContain('Anthropic 兼容');
        expect(labels).toContain('阿里云百炼');
        expect(labels).toContain('智谱');
    });

    it('registers Xiaomi MiMo as a builtin provider driver', () => {
        expect(isProviderDriver('mimo')).toBe(true);

        const definition = getProviderDriverDefinition('mimo');
        expect(definition.label).toBe('Xiaomi MiMo');
        expect(definition.logo).toBe('mimo.png');
        expect(definition.placeholder).toBe('https://token-plan-cn.xiaomimimo.com/v1');

        expect(getProviderDriverDefinitions().some((item) => item.driver === 'mimo')).toBe(true);
    });

    it('keeps the legacy exported definition list available for non-reactive callers', () => {
        expect(providerDriverDefinitions.map((definition) => definition.driver)).toContain(
            'openai-compatible'
        );
    });

    it('keeps the legacy exported definition list localized after a runtime locale switch', () => {
        expect(
            providerDriverDefinitions.find((definition) => definition.driver === 'alibaba')?.label
        ).toBe('阿里云百炼');

        setLocale('en-US');

        expect(
            providerDriverDefinitions.find((definition) => definition.driver === 'alibaba')?.label
        ).toBe('Alibaba Cloud Bailian');
    });

    it('validates provider driver values and rejects unknown drivers', () => {
        expect(isProviderDriver('openai')).toBe(true);
        expect(isProviderDriver('unknown')).toBe(false);
        expect(parseProviderDriver('openai-compatible')).toBe('openai-compatible');
        expect(() => parseProviderDriver('unknown')).toThrow('Unknown provider driver: unknown');
        expect(() => getProviderDriverDefinition('unknown' as ProviderDriver)).toThrow(
            'Unknown provider driver: unknown'
        );
    });

    it('creates every registered provider adapter without translating runtime driver ids', () => {
        for (const definition of getProviderDriverDefinitions()) {
            const provider = createProviderFromRegistry(definition.driver, {
                apiEndpoint: definition.placeholder,
                apiKey: 'test-key',
                config: null,
            });

            expect(provider.driver).toBe(definition.driver);
            expect(provider.getApiTargets().normalizedBaseUrl).not.toBe('');
        }
    });
});
