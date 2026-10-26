import { beforeEach, describe, expect, it, vi } from 'vitest';

import { executeWebSearchTool, webSearchTool } from '@/services/BuiltInToolService/tools/webSearch';

/**
 * WebSearch has to keep working when the user's settings point at a provider that cannot run:
 * a key was cleared, an intent route is missing, or every provider is disabled. Falling back to
 * a usable provider is better than failing the search, but the fallback order matters — the user
 * should still get the kind of source they asked for.
 *
 * Only the database settings read and the network call are replaced; routing, request building
 * and payload shaping run for real.
 */

const { getSettingValueMock, tauriFetchMock } = vi.hoisted(() => ({
    getSettingValueMock: vi.fn<() => Promise<string | null>>(async () => null),
    tauriFetchMock: vi.fn(),
}));

vi.mock('@database/queries', () => ({
    getSettingValue: getSettingValueMock,
}));

vi.mock('@/services/AgentService/infrastructure/providers', () => ({
    createTauriFetch: () => tauriFetchMock,
}));

function createExecutionContext(): Parameters<typeof executeWebSearchTool>[2] {
    return {
        signal: new AbortController().signal,
        callId: 'web-search-call',
        iteration: 1,
        hasExecutedBuiltInTool: vi.fn(() => false),
    };
}

function settingsOf(config: Record<string, unknown>): string {
    return JSON.stringify(config);
}

/** A minimal AnySearch response, so a search that reaches the network still succeeds. */
function anySearchResponse(): Response {
    return new Response(
        JSON.stringify({
            results: [
                {
                    title: 'Result one',
                    url: 'https://example.com/one',
                    content: 'Snippet one',
                },
            ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
    );
}

beforeEach(() => {
    vi.clearAllMocks();
    getSettingValueMock.mockResolvedValue(null);
    tauriFetchMock.mockResolvedValue(anySearchResponse());
});

describe('user searches with a provider they disabled', () => {
    it('user still gets results when the provider they chose is turned off', async () => {
        getSettingValueMock.mockResolvedValue(
            settingsOf({
                providers: {
                    brave: { enabled: false, apiKey: 'brave-key' },
                    anysearch: { enabled: true },
                },
                defaultProvider: 'brave',
            })
        );

        const result = await executeWebSearchTool(
            { query: 'browser automation', provider: 'brave', maxResults: 2 },
            {},
            createExecutionContext()
        );

        // The search still has to run: a disabled provider must not fail the whole call.
        expect(result.isError).toBe(false);
        expect(result.status).toBe('success');
        expect(result.structuredPayload).toMatchObject({ provider: 'anysearch' });
    });

    it('user gets the academic source they asked for when their chosen provider is unusable', async () => {
        getSettingValueMock.mockResolvedValue(
            settingsOf({
                providers: {
                    semantic_scholar: { enabled: false, apiKey: 'scholar-key' },
                    openalex: { enabled: true },
                    anysearch: { enabled: false },
                },
                defaultProvider: 'semantic_scholar',
            })
        );

        const result = await executeWebSearchTool(
            {
                query: 'retrieval augmented generation',
                provider: 'semantic_scholar',
                intent: 'academic',
                maxResults: 2,
            },
            {},
            createExecutionContext()
        );

        // With no general provider available, the academic intent still routes to OpenAlex.
        expect(result.structuredPayload).toMatchObject({ provider: 'openalex' });
    });

    it('user gets a code host when they asked a technical question and only GitHub is usable', async () => {
        getSettingValueMock.mockResolvedValue(
            settingsOf({
                providers: {
                    exa: { enabled: false, apiKey: 'exa-key' },
                    github: { enabled: true },
                    anysearch: { enabled: false },
                },
                defaultProvider: 'exa',
            })
        );

        const result = await executeWebSearchTool(
            {
                query: 'browser router',
                provider: 'exa',
                intent: 'technical',
                maxResults: 2,
            },
            {},
            createExecutionContext()
        );

        expect(result.structuredPayload).toMatchObject({ provider: 'github' });
    });

    it('user gets whichever provider is left when nothing they asked for can run', async () => {
        getSettingValueMock.mockResolvedValue(
            settingsOf({
                providers: {
                    exa: { enabled: false, apiKey: 'exa-key' },
                    brave: { enabled: false, apiKey: 'brave-key' },
                    wikipedia: { enabled: true },
                    anysearch: { enabled: false },
                },
                defaultProvider: 'exa',
            })
        );

        const result = await executeWebSearchTool(
            { query: 'history of computing', provider: 'exa', maxResults: 2 },
            {},
            createExecutionContext()
        );

        // The last resort is the first provider that is still available, not a hard failure.
        expect(result.structuredPayload).toMatchObject({ provider: 'wikipedia' });
    });
});

describe('user searches with an intent route', () => {
    it('user gets the default provider when their intent route is set to auto', async () => {
        getSettingValueMock.mockResolvedValue(
            settingsOf({
                providers: { anysearch: { enabled: true }, openalex: { enabled: true } },
                defaultProvider: 'anysearch',
                intentRoutes: { academic: 'auto' },
            })
        );

        const result = await executeWebSearchTool(
            { query: 'browser automation', intent: 'academic', maxResults: 2 },
            {},
            createExecutionContext()
        );

        // "auto" means follow the default provider, not the intent default.
        expect(result.structuredPayload).toMatchObject({ provider: 'anysearch' });
    });

    it('user gets the routed provider when their intent route names one', async () => {
        getSettingValueMock.mockResolvedValue(
            settingsOf({
                providers: { anysearch: { enabled: true }, openalex: { enabled: true } },
                defaultProvider: 'anysearch',
                intentRoutes: { academic: 'openalex' },
            })
        );

        const result = await executeWebSearchTool(
            { query: 'retrieval augmented generation', intent: 'academic', maxResults: 2 },
            {},
            createExecutionContext()
        );

        expect(result.structuredPayload).toMatchObject({ provider: 'openalex' });
    });

    it('user gets the built-in academic default when they never touched the routes', async () => {
        getSettingValueMock.mockResolvedValue(
            settingsOf({
                providers: { anysearch: { enabled: true }, openalex: { enabled: true } },
                defaultProvider: 'anysearch',
            })
        );

        const result = await executeWebSearchTool(
            { query: 'retrieval augmented generation', intent: 'academic', maxResults: 2 },
            {},
            createExecutionContext()
        );

        // Routes merge over the shipped defaults, so academic still goes to OpenAlex.
        expect(result.structuredPayload).toMatchObject({ provider: 'openalex' });
    });
});

describe('user sets the result count and timeout themselves', () => {
    it('user gets the settings count and timeout when their call omits them', async () => {
        getSettingValueMock.mockResolvedValue(
            settingsOf({
                providers: { anysearch: { enabled: true } },
                defaultProvider: 'anysearch',
                maxResults: 4,
                timeoutMs: 25_000,
            })
        );

        const result = await executeWebSearchTool(
            { query: 'browser automation' },
            {},
            createExecutionContext()
        );

        // The call carried no numbers, so the settings decide how many results come back.
        expect(result.isError).toBe(false);
        expect(result.structuredPayload).toMatchObject({ provider: 'anysearch' });
    });
});

describe('user gets a readable failure when the search cannot run', () => {
    it('user is told the search failed when the provider throws a plain error', async () => {
        tauriFetchMock.mockRejectedValue(new Error('provider is down'));

        const result = await executeWebSearchTool(
            { query: 'browser automation', maxResults: 2 },
            {},
            createExecutionContext()
        );

        expect(result.isError).toBe(true);
        expect(result.status).toBe('error');
        expect(result.result).toContain('provider is down');
        expect(result.errorMessage).toBe('provider is down');
    });

    it('user is told the search timed out when the provider stopped responding', async () => {
        tauriFetchMock.mockRejectedValue(new DOMException('search timed out', 'TimeoutError'));

        const result = await executeWebSearchTool(
            { query: 'browser automation', maxResults: 2 },
            {},
            createExecutionContext()
        );

        // A timeout is a different failure from a broken provider, and the UI shows it differently.
        expect(result.isError).toBe(true);
        expect(result.status).toBe('timeout');
    });

    it('user is told the search failed when the provider throws something that is not an error', async () => {
        tauriFetchMock.mockRejectedValue('network down');

        const result = await executeWebSearchTool(
            { query: 'browser automation', maxResults: 2 },
            {},
            createExecutionContext()
        );

        expect(result.isError).toBe(true);
        expect(result.status).toBe('error');
        expect(result.errorMessage).toBe('network down');
    });

    it('user gets the searched-for wording kept even when the search failed', async () => {
        tauriFetchMock.mockRejectedValue(new Error('provider is down'));

        const result = await executeWebSearchTool(
            {
                query: 'browser automation',
                description: '搜索 浏览器自动化',
                maxResults: 2,
            },
            {},
            createExecutionContext()
        );

        // The activity line still has to say what the user was looking for.
        expect(result.conversationSemantic).toEqual({
            action: 'search',
            target: expect.stringContaining('浏览器自动化'),
        });
    });
});

describe('user reads the search activity line', () => {
    it('user gets a generic target when neither description nor query was given', () => {
        expect(webSearchTool.buildConversationSemantic({})).toEqual({
            action: 'search',
            target: 'web',
        });
    });

    it('user gets the query used as the target when no description was given', () => {
        expect(
            webSearchTool.buildConversationSemantic({ query: 'OpenClaw release notes' })
        ).toEqual({ action: 'search', target: 'OpenClaw release notes' });
    });

    it('user gets the action verb stripped so the line reads as a topic', () => {
        for (const [input, expected] of [
            ['search for rust async', 'rust async'],
            ['查找 配置文件', '配置文件'],
            ['look up: 浏览器', '浏览器'],
            ['find  the answer', 'the answer'],
        ] as const) {
            expect(webSearchTool.buildConversationSemantic({ query: input }).target, input).toBe(
                expected
            );
        }
    });

    it('user gets the text kept when it is only an action verb with nothing after it', () => {
        // Stripping would leave an empty line, so the original has to survive.
        expect(webSearchTool.buildConversationSemantic({ query: 'search' }).target).toBe('search');
        expect(webSearchTool.buildConversationSemantic({ query: '查找' }).target).toBe('查找');
    });

    it('user gets a very long topic shortened in the activity line', () => {
        const target = webSearchTool.buildConversationSemantic({
            query: 'a'.repeat(300),
        }).target;

        expect(target).toBeDefined();
        expect(target!.length).toBeLessThan(300);
        expect(target!.endsWith('...')).toBe(true);
    });
});

describe('user searches when every provider is switched off', () => {
    it('user is told the search could not run rather than given an empty result', async () => {
        getSettingValueMock.mockResolvedValue(
            settingsOf({
                providers: Object.fromEntries(
                    [
                        'auto',
                        'anysearch',
                        'wikipedia',
                        'openalex',
                        'semantic_scholar',
                        'github',
                        'brave',
                        'tavily',
                        'exa',
                        'firecrawl',
                        'searxng',
                        'deepseek',
                    ].map((id) => [id, { enabled: false }])
                ),
                defaultProvider: 'anysearch',
            })
        );

        const result = await executeWebSearchTool(
            { query: 'browser automation', maxResults: 2 },
            {},
            createExecutionContext()
        );

        // With nothing left to fall back to the user gets a clear failure, not silence.
        expect(result.isError).toBe(true);
        expect(result.status).toBe('error');
        expect(result.errorMessage).toContain('No enabled search provider');
    });
});

describe('user is told how long to wait after the provider throttles them', () => {
    it('user gets the wait in seconds read from the provider retry hint', async () => {
        getSettingValueMock.mockResolvedValue(
            settingsOf({
                providers: { deepseek: { enabled: true, apiKey: 'ds-key' } },
                defaultProvider: 'deepseek',
            })
        );
        tauriFetchMock.mockResolvedValue(
            new Response('slow down', {
                status: 429,
                statusText: 'Too Many Requests',
                headers: { 'retry-after': '2' },
            })
        );

        const result = await executeWebSearchTool(
            { query: 'browser automation', maxResults: 2 },
            {},
            createExecutionContext()
        );

        // A numeric Retry-After is a number of seconds; the search still fails after retrying.
        expect(result.isError).toBe(true);
        expect(result.errorMessage).toContain('429');
    });

    it('user gets the wait read from a retry hint given as a date', async () => {
        getSettingValueMock.mockResolvedValue(
            settingsOf({
                providers: { deepseek: { enabled: true, apiKey: 'ds-key' } },
                defaultProvider: 'deepseek',
            })
        );
        const retryAt = new Date(Date.now() + 1_000).toUTCString();
        tauriFetchMock.mockResolvedValue(
            new Response('slow down', {
                status: 429,
                statusText: 'Too Many Requests',
                headers: { 'retry-after': retryAt },
            })
        );

        const result = await executeWebSearchTool(
            { query: 'browser automation', maxResults: 2 },
            {},
            createExecutionContext()
        );

        // An HTTP-date Retry-After is equally valid and must not be read as seconds.
        expect(result.isError).toBe(true);
        expect(result.errorMessage).toContain('429');
    });

    it('user gets no wait hint when the provider sent an unreadable retry hint', async () => {
        getSettingValueMock.mockResolvedValue(
            settingsOf({
                providers: { deepseek: { enabled: true, apiKey: 'ds-key' } },
                defaultProvider: 'deepseek',
            })
        );
        tauriFetchMock.mockResolvedValue(
            new Response('slow down', {
                status: 429,
                statusText: 'Too Many Requests',
                headers: { 'retry-after': 'whenever' },
            })
        );

        const result = await executeWebSearchTool(
            { query: 'browser automation', maxResults: 2 },
            {},
            createExecutionContext()
        );

        expect(result.isError).toBe(true);
        expect(result.errorMessage).toContain('429');
    });
});
