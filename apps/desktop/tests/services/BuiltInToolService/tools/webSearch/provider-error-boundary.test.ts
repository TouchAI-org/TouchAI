import { describe, expect, it } from 'vitest';

import { resolveToolFailure } from '@/services/BuiltInToolService/errors';
import { exaAdapter } from '@/services/BuiltInToolService/tools/webSearch/providers/exa';
import type { SearchSettingsConfig } from '@/services/SettingsService/domain';

function searchSettings(): SearchSettingsConfig {
    return {
        defaultProvider: 'exa',
        providers: {
            brave: { enabled: false, apiKey: '' },
            deepseek: { enabled: false, apiKey: '', endpoint: 'https://api.deepseek.com' },
            exa: { enabled: true, apiKey: '' },
            tavily: { enabled: false, apiKey: '' },
            firecrawl: { enabled: false, apiKey: '' },
            wikipedia: { enabled: false },
            github: { enabled: false },
        },
    } as SearchSettingsConfig;
}

describe('user never sees an upstream search provider error verbatim', () => {
    it('user gets a stable search failure when the keyless Exa MCP reports an error', async () => {
        const fetchText = async () =>
            `data: ${JSON.stringify({
                error: { message: 'secret relay token=exa-private-token' },
            })}\n\n`;

        const failure = await exaAdapter
            .search({
                request: {
                    query: 'OpenClaw',
                    provider: 'exa',
                    intent: 'general',
                    domains: [],
                    maxResults: 5,
                    timeoutMs: 1000,
                },
                settings: searchSettings(),
                signal: new AbortController().signal,
                fetchJson: async () => ({}),
                fetchText,
            })
            .then(
                () => null,
                (error: unknown) =>
                    resolveToolFailure(error, {
                        toolId: 'web_search',
                        fallbackMessage: 'Search failed',
                        timeoutMessage: 'Search timed out',
                    })
            );

        expect(JSON.stringify(failure)).not.toContain('exa-private-token');
        expect(failure).toEqual({ message: 'Search failed', status: 'error' });
    });
});
