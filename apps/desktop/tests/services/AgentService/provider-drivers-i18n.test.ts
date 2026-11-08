import { beforeEach, describe, expect, it } from 'vitest';

import type { ProviderDriver } from '@/database/schema';
import { setLocale } from '@/i18n';
import {
    getProviderDriverDefinition,
    getProviderDriverDefinitions,
    isProviderDriver,
    parseProviderDriver,
    providerDriverDefinitions,
} from '@/services/AgentService/infrastructure/providers';
import { createProviderFromRegistry } from '@/services/AgentService/infrastructure/providers/drivers';

describe('user picks a provider driver in their own language', () => {
    beforeEach(() => {
        setLocale('zh-CN');
    });

    it('user reads provider driver labels in English', () => {
        setLocale('en-US');

        expect(getProviderDriverDefinition('openai-compatible').label).toBe('OpenAI compatible');
        expect(getProviderDriverDefinition('anthropic-compatible').label).toBe(
            'Anthropic compatible'
        );
        expect(getProviderDriverDefinition('alibaba').label).toBe('Alibaba Cloud Bailian');
        expect(getProviderDriverDefinition('zhipu').label).toBe('Zhipu');
    });

    it('user reads provider driver labels in Chinese in the default locale', () => {
        const labels = getProviderDriverDefinitions().map((definition) => definition.label);

        expect(labels).toContain('OpenAI 兼容');
        expect(labels).toContain('Anthropic 兼容');
        expect(labels).toContain('阿里云百炼');
        expect(labels).toContain('智谱');
    });

    it('user can pick Xiaomi MiMo as a built-in provider driver', () => {
        expect(isProviderDriver('mimo')).toBe(true);

        const definition = getProviderDriverDefinition('mimo');
        expect(definition.label).toBe('Xiaomi MiMo');
        expect(definition.logo).toBe('mimo.png');
        expect(definition.placeholder).toBe('https://token-plan-cn.xiaomimimo.com/v1');

        expect(getProviderDriverDefinitions().some((item) => item.driver === 'mimo')).toBe(true);
    });

    it('user sees the exported driver list stay usable for non-reactive callers', () => {
        expect(providerDriverDefinitions.map((definition) => definition.driver)).toContain(
            'openai-compatible'
        );
    });

    it('user sees the exported driver list follow a runtime locale switch', () => {
        expect(
            providerDriverDefinitions.find((definition) => definition.driver === 'alibaba')?.label
        ).toBe('阿里云百炼');

        setLocale('en-US');

        expect(
            providerDriverDefinitions.find((definition) => definition.driver === 'alibaba')?.label
        ).toBe('Alibaba Cloud Bailian');
    });

    it('user cannot select an unknown provider driver', () => {
        expect(isProviderDriver('openai')).toBe(true);
        expect(isProviderDriver('unknown')).toBe(false);
        expect(parseProviderDriver('openai-compatible')).toBe('openai-compatible');
        expect(() => parseProviderDriver('unknown')).toThrow('Unknown provider driver: unknown');
        expect(() => getProviderDriverDefinition('unknown' as ProviderDriver)).toThrow(
            'Unknown provider driver: unknown'
        );
    });

    it('user sees every registered driver produce a working adapter with stable ids', () => {
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
