import { createWebSearchToolsFixture } from '@tests/utils/webSearchTools';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { readSettings, fetchMock } = vi.hoisted(() => ({
    readSettings: vi.fn(),
    fetchMock: vi.fn(),
}));

vi.mock('@/platform/http', () => ({
    createTauriFetch: () => fetchMock,
    cancelResponseBody: vi.fn(async () => {}),
}));

const context = () => ({
    signal: new AbortController().signal,
    callId: 'endpoint',
    iteration: 1,
});
const response = (payload: unknown) =>
    new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    });

beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockResolvedValue(response({ results: [] }));
});

describe('user points a provider at a compatible gateway', () => {
    it.each(['https://firecrawl.gateway.test', 'https://firecrawl.gateway.test/v2/search'])(
        'user sends Firecrawl search to the configured gateway %s',
        async (endpoint) => {
            readSettings.mockResolvedValue(
                JSON.stringify({
                    providers: { firecrawl: { enabled: true, apiKey: 'gateway-key', endpoint } },
                })
            );
            await executeWebSearchTool({ query: 'q', provider: 'firecrawl' }, {}, context());
            expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
                'https://firecrawl.gateway.test/v2/search'
            );
            expect(fetchMock.mock.calls[0]?.[1]?.headers.Authorization).toBe('Bearer gateway-key');
        }
    );
    it('user keeps the Exa endpoint base and appends the search path', async () => {
        readSettings.mockResolvedValue(
            JSON.stringify({
                defaultProvider: 'exa',
                providers: {
                    exa: { enabled: true, apiKey: 'key', endpoint: 'https://exa.gateway.test' },
                },
            })
        );
        await executeWebSearchTool({ query: 'q', provider: 'exa' }, {}, context());
        expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://exa.gateway.test/search');
    });

    it('user keeps a full Exa endpoint unchanged', async () => {
        readSettings.mockResolvedValue(
            JSON.stringify({
                defaultProvider: 'exa',
                providers: {
                    exa: {
                        enabled: true,
                        apiKey: 'key',
                        endpoint: 'https://exa.gateway.test/search',
                    },
                },
            })
        );
        await executeWebSearchTool({ query: 'q', provider: 'exa' }, {}, context());
        expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://exa.gateway.test/search');
    });

    it('user keeps the Tavily endpoint base and appends the search path', async () => {
        readSettings.mockResolvedValue(
            JSON.stringify({
                defaultProvider: 'tavily',
                providers: {
                    tavily: { enabled: true, endpoint: 'https://tavily.gateway.test' },
                },
            })
        );
        await executeWebSearchTool({ query: 'q', provider: 'tavily' }, {}, context());
        expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://tavily.gateway.test/search');
    });

    it('user keeps a full Serper endpoint unchanged', async () => {
        readSettings.mockResolvedValue(
            JSON.stringify({
                defaultProvider: 'serper',
                providers: {
                    serper: {
                        enabled: true,
                        apiKey: 'key',
                        endpoint: 'https://serper.gateway.test/search',
                    },
                },
            })
        );
        await executeWebSearchTool({ query: 'q', provider: 'serper' }, {}, context());
        expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://serper.gateway.test/search');
    });
});

const { execute: executeWebSearchTool } = createWebSearchToolsFixture({
    configuration: { read: readSettings },
});
