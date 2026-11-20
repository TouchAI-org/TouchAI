import { describe, expect, it } from 'vitest';

import { getProviderApiTargets } from '../src/catalog';
import type { ProviderDriver } from '../src/contracts';

const targets: { driver: ProviderDriver; path: string; generation: string }[] = [
    { driver: 'openai', path: '/v1', generation: '/responses' },
    { driver: 'openai-compatible', path: '/v1', generation: '/chat/completions' },
    { driver: 'anthropic', path: '/v1', generation: '/messages' },
    { driver: 'anthropic-compatible', path: '', generation: '/messages' },
    { driver: 'google', path: '/v1beta', generation: '/models/{model}:streamGenerateContent' },
    { driver: 'deepseek', path: '', generation: '/chat/completions' },
    { driver: 'xai', path: '/v1', generation: '/chat/completions' },
    { driver: 'moonshot', path: '/v1', generation: '/chat/completions' },
    { driver: 'alibaba', path: '/compatible-mode/v1', generation: '/chat/completions' },
    { driver: 'minimax', path: '/anthropic/v1', generation: '/messages' },
    { driver: 'zhipu', path: '/api/paas/v4', generation: '/chat/completions' },
    { driver: 'mimo', path: '/v1', generation: '/chat/completions' },
];

describe('given an explicit Provider driver and saved endpoint', () => {
    it.each(targets)(
        'user sees the existing $driver endpoint defaults without a connection or credentials',
        ({ driver, path, generation }) => {
            const base = 'https://fixture.invalid';
            expect(getProviderApiTargets(driver, `${base}///`)).toEqual({
                normalizedBaseUrl: base,
                sdkBaseUrl: base + path,
                generationTarget: base + path + generation,
                discoveryTarget: base + path + '/models',
            });
        }
    );

    it.each(targets)(
        'user keeps the exact $driver gateway path when previewing a saved custom endpoint',
        ({ driver, generation }) => {
            const base = 'https://fixture.invalid/custom/gateway';
            const version = driver === 'google' ? '/v1beta' : '';
            expect(getProviderApiTargets(driver, `${base}/`)).toEqual({
                normalizedBaseUrl: base,
                sdkBaseUrl: base + version,
                generationTarget: base + version + generation,
                discoveryTarget: base + version + '/models',
            });
        }
    );

    it('user previews an endpoint with many internal slashes promptly without changing its gateway path', () => {
        const base = `https://fixture.invalid/${'/'.repeat(65_536)}gateway`;
        const started = performance.now();
        const result = getProviderApiTargets('openai-compatible', `${base}///`);
        const elapsed = performance.now() - started;
        expect(result).toEqual({
            normalizedBaseUrl: base,
            sdkBaseUrl: base,
            generationTarget: `${base}/chat/completions`,
            discoveryTarget: `${base}/models`,
        });
        expect(elapsed).toBeLessThan(500);
    });

    it('user sees no fabricated endpoint when the saved endpoint is empty', () => {
        expect(getProviderApiTargets('openai', '')).toEqual({
            normalizedBaseUrl: '',
            sdkBaseUrl: '',
            generationTarget: '',
            discoveryTarget: '',
        });
    });

    it('user sees the configured chat protocol instead of a hidden default when changing the official Provider format', () => {
        expect(
            getProviderApiTargets('openai', 'https://fixture.invalid', 'openai').generationTarget
        ).toBe('https://fixture.invalid/v1/chat/completions');
        expect(
            getProviderApiTargets('openai', 'https://fixture.invalid', 'openai-responses')
                .generationTarget
        ).toBe('https://fixture.invalid/v1/responses');
    });
});
