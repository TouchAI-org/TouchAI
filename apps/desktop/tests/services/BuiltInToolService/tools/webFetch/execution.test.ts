import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import { executeWebFetchTool } from '@/services/BuiltInToolService/tools/webFetch';

const { tauriFetchMock } = vi.hoisted(() => ({
    tauriFetchMock: vi.fn(),
}));

vi.mock('@/services/AgentService/infrastructure/providers', () => ({
    createTauriFetch: () => tauriFetchMock,
}));

function createExecutionContext(): Parameters<typeof executeWebFetchTool>[2] {
    return {
        signal: new AbortController().signal,
        callId: 'web-fetch-call',
        iteration: 1,
        hasExecutedBuiltInTool: vi.fn(() => false),
    };
}

describe('WebFetch execution', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setLocale('en-US');
    });

    it('sends browser-like headers for ordinary page fetches', async () => {
        tauriFetchMock.mockResolvedValueOnce(
            new Response('<main>Official page</main>', {
                status: 200,
                headers: { 'content-type': 'text/html' },
            })
        );

        const result = await executeWebFetchTool(
            { url: 'https://example.test/report', mode: 'reader', maxChars: 1000 },
            {},
            createExecutionContext()
        );

        expect(result.isError).toBe(false);
        expect(tauriFetchMock).toHaveBeenCalledWith(
            'https://example.test/report',
            expect.objectContaining({
                headers: expect.objectContaining({
                    Accept: expect.stringContaining('text/html'),
                    'Accept-Language': expect.stringContaining('zh-CN'),
                    Referer: 'https://example.test/',
                    'User-Agent': expect.stringContaining('Chrome/'),
                }),
            })
        );
    });

    it('reuses a short-lived cache entry for repeated identical requests', async () => {
        tauriFetchMock.mockResolvedValueOnce(
            new Response('<main>Cached page</main>', {
                status: 200,
                headers: { 'content-type': 'text/html' },
            })
        );

        const args = { url: 'https://example.test/cache', mode: 'reader', maxChars: 1000 };
        const first = await executeWebFetchTool(args, {}, createExecutionContext());
        const second = await executeWebFetchTool(args, {}, createExecutionContext());

        expect(first.isError).toBe(false);
        expect(second.isError).toBe(false);
        expect(second.result).toBe(first.result);
        expect(tauriFetchMock).toHaveBeenCalledTimes(1);
    });

    it('falls back to Jina Reader when the ordinary fetch path is blocked', async () => {
        tauriFetchMock
            .mockResolvedValueOnce(
                new Response('Forbidden', {
                    status: 403,
                    statusText: 'Forbidden',
                    headers: { 'content-type': 'text/plain' },
                })
            )
            .mockResolvedValueOnce(
                new Response('# Reader result\n\nFetched by reader fallback.', {
                    status: 200,
                    headers: { 'content-type': 'text/markdown' },
                })
            );

        const result = await executeWebFetchTool(
            { url: 'https://blocked.example/article', mode: 'reader', maxChars: 2000 },
            {},
            createExecutionContext()
        );

        expect(result.isError).toBe(false);
        expect(result.result).toContain('Fetched by reader fallback.');
        expect(result.result).toContain('Fallback: Jina Reader');
        expect(tauriFetchMock).toHaveBeenLastCalledWith(
            'https://r.jina.ai/https://blocked.example/article',
            expect.anything()
        );
    });

    it('can still read an explicitly provided search result URL', async () => {
        tauriFetchMock.mockResolvedValueOnce(
            new Response('<main>Search result page explicitly requested</main>', {
                status: 200,
                headers: { 'content-type': 'text/html' },
            })
        );

        const result = await executeWebFetchTool(
            {
                url: 'https://www.google.com/search?q=openclaw',
                mode: 'reader',
                maxChars: 1000,
            },
            {},
            createExecutionContext()
        );

        expect(result.isError).toBe(false);
        expect(tauriFetchMock).toHaveBeenCalledWith(
            'https://www.google.com/search?q=openclaw',
            expect.anything()
        );
    });
});
