import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWebFetchTools, createWebSearchTools } from '@/modules/tools';

const boundary = vi.hoisted(() => ({
    requests: [] as { url: string; init?: RequestInit }[],
    response: null as null | ((url: string) => Response),
}));
vi.mock('@/platform/http', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/platform/http')>();
    return {
        ...original,
        createTauriFetch: () => async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            boundary.requests.push({ url, init });
            return (
                boundary.response?.(url) ??
                new Response('fixture page', { headers: { 'content-type': 'text/plain' } })
            );
        },
    };
});

afterEach(() => {
    boundary.requests.length = 0;
    boundary.response = null;
});
const messages = { t: (key: string) => key, tt: (text: string) => text };
const scope = { callId: 'call', iteration: 0 };

describe('given public web tools have instance-scoped effects and turn-bound configuration', () => {
    it('user reads a public page and gets bounded content without a global transport or tool registry', async () => {
        const [tool] = createWebFetchTools({
            messages,
            configuration: { read: async () => JSON.stringify({ fetchStrategy: 'direct' }) },
        });
        const result = await tool!.execute(
            { url: 'https://example.test/article', mode: 'page_text', maxChars: 500 },
            {},
            scope
        );
        expect(result).toMatchObject({ isError: false, status: 'success' });
        expect(result.result).toContain('fixture page');
        expect(boundary.requests.map((request) => request.url)).toEqual([
            'https://example.test/article',
        ]);
    });

    it('user cannot follow a public page redirect into a private host', async () => {
        boundary.response = () =>
            new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } });
        const [tool] = createWebFetchTools({
            messages,
            configuration: { read: async () => JSON.stringify({ fetchStrategy: 'direct' }) },
        });
        const result = await tool!.execute(
            { url: 'https://example.test/article', mode: 'page_text', maxChars: 500 },
            {},
            scope
        );
        expect(result).toMatchObject({ isError: true, status: 'error' });
        expect(result.result).toContain('blockedHost');
        expect(boundary.requests.map((request) => request.url)).toEqual([
            'https://example.test/article',
        ]);
    });

    it('user searches through the advertised endpoint even when the settings change before its effect', async () => {
        let settings = JSON.stringify({
            defaultProvider: 'searxng',
            providers: {
                searxng: { enabled: true, endpoint: 'https://first.test/' },
            },
        });
        boundary.response = () =>
            Response.json({
                results: [{ title: 'Fixture result', url: 'https://source.test/article' }],
            });
        const [descriptor] = createWebSearchTools({
            configuration: { read: async () => settings },
        });
        const tool = await descriptor!.prepareForTurn({});
        const declaration = await tool.buildToolDefinition('builtin__web_search', {});
        settings = JSON.stringify({
            defaultProvider: 'anysearch',
            providers: {
                searxng: { enabled: true, endpoint: 'https://replacement.test/' },
            },
        });
        const result = await tool.execute({ query: 'fixture', provider: 'searxng' }, {}, scope);
        expect(declaration.input_schema.properties.provider).toMatchObject({
            enum: expect.arrayContaining(['searxng']),
        });
        expect(result).toMatchObject({
            isError: false,
            structuredPayload: { kind: 'web_search_sources', provider: 'searxng' },
        });
        expect(boundary.requests[0]?.url).toMatch(/^https:\/\/first\.test\/search\?/);
        expect(result.result).toContain('Fixture result');
    });

    it('user cannot start a new search effect after the advertised provider is disabled', async () => {
        let settings = JSON.stringify({
            defaultProvider: 'searxng',
            providers: {
                searxng: { enabled: true, endpoint: 'https://first.test/' },
            },
        });
        const [descriptor] = createWebSearchTools({
            configuration: { read: async () => settings },
        });
        const tool = await descriptor!.prepareForTurn({});
        settings = JSON.stringify({
            providers: { searxng: { enabled: false, endpoint: 'https://first.test/' } },
        });
        const result = await tool.execute({ query: 'fixture', provider: 'searxng' }, {}, scope);
        expect(result.isError).toBe(true);
        expect(boundary.requests).toEqual([]);
    });
});
