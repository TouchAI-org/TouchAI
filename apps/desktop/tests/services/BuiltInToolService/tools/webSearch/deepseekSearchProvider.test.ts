import { beforeEach, describe, expect, it, vi } from 'vitest';

import { executeWebSearchTool } from '@/services/BuiltInToolService/tools/webSearch';
import type { WebSearchRequest } from '@/services/BuiltInToolService/tools/webSearch/helper';
import {
    buildDeepSeekQuery,
    buildDeepSeekToolsUrl,
    createRequestScheduler,
    DEEPSEEK_QUERY_MAX_CHARS,
    deepSeekRetryDelayMs,
    describeDeepSeekFailure,
    isRetryableDeepSeekError,
    rankDeepSeekResults,
    runWithDeepSeekRetry,
    toDeepSeekResult,
} from '@/services/BuiltInToolService/tools/webSearch/providers/deepseek';
import { WebSearchHttpError } from '@/services/BuiltInToolService/tools/webSearch/providers/types';

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
        callId: 'deepseek-web-search-call',
        iteration: 1,
        hasExecutedBuiltInTool: vi.fn(() => false),
    };
}

function jsonResponse(payload: unknown, status = 200, headers: Record<string, string> = {}) {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
    });
}

function baseRequest(overrides: Partial<WebSearchRequest> = {}): WebSearchRequest {
    return {
        query: 'DeepSeek V4 发布',
        provider: 'deepseek',
        intent: 'general',
        domains: [],
        maxResults: 6,
        timeoutMs: 15_000,
        ...overrides,
    };
}

function deepseekSettings(provider: Record<string, unknown>): string {
    return JSON.stringify({
        defaultProvider: 'deepseek',
        providers: { deepseek: { enabled: true, ...provider } },
    });
}

function requestBody(callIndex = 0): Record<string, unknown> {
    return JSON.parse(String(tauriFetchMock.mock.calls[callIndex]?.[1]?.body));
}

function requestHeaders(callIndex = 0): Record<string, string> {
    return tauriFetchMock.mock.calls[callIndex]?.[1]?.headers as Record<string, string>;
}

describe('DeepSeek query mapping', () => {
    it('maps domains to site: operators and recency to after:', () => {
        const query = buildDeepSeekQuery(
            baseRequest({
                domains: ['github.com', 'huggingface.co'],
                recencyDays: 30,
            })
        );

        expect(query).toContain('site:github.com OR site:huggingface.co');
        expect(query).toMatch(/after:\d{4}-\d{2}-\d{2}/);
        expect(query.startsWith('DeepSeek V4 发布')).toBe(true);
    });

    it('drops operators instead of truncating the query when the budget is exhausted', () => {
        const longQuery = 'a'.repeat(DEEPSEEK_QUERY_MAX_CHARS - 8);
        const query = buildDeepSeekQuery(
            baseRequest({ query: longQuery, domains: ['github.com'] })
        );

        expect(query).toBe(longQuery);
    });

    it('keeps the query untouched when no operator applies', () => {
        expect(buildDeepSeekQuery(baseRequest())).toBe('DeepSeek V4 发布');
    });

    it('caps the number of site: operators', () => {
        const query = buildDeepSeekQuery(
            baseRequest({
                query: 'q',
                domains: Array.from({ length: 12 }, (_, index) => `s${index}.com`),
            })
        );

        expect(query.match(/site:/g)).toHaveLength(8);
    });
});

describe('DeepSeek result mapping', () => {
    it('prefers the model-facing summary over the UI snippet', () => {
        const result = toDeepSeekResult({
            title: 'DeepSeek V4 model released',
            url: 'https://example.com/deepseek-v4',
            snippet: 'Short UI text',
            summary: 'Long model-facing summary',
            rerank_score: 2.4,
            authority: 3,
            site_name: 'Example News',
            site_icon: 'https://example.com/favicon.ico',
            date: '2026-06-01T00:00:00+00:00',
            content: '# Body',
        });

        expect(result).toMatchObject({
            title: 'DeepSeek V4 model released',
            snippet: 'Long model-facing summary',
            source: 'Example News',
            score: 2.4,
            authority: 3,
            publishedAt: '2026-06-01T00:00:00+00:00',
            favicon: 'https://example.com/favicon.ico',
            content: '# Body',
        });
    });

    it('normalizes unknown authority and missing optional fields', () => {
        const result = toDeepSeekResult({
            title: 'DeepSeek result',
            url: 'https://example.com/post',
            snippet: 'Fallback snippet',
            authority: -1,
            date: null,
        });

        expect(result).toMatchObject({
            snippet: 'Fallback snippet',
            source: 'example.com',
            authority: undefined,
            publishedAt: undefined,
            score: undefined,
        });
    });

    it('drops malformed entries', () => {
        expect(toDeepSeekResult({ title: 'no url' })).toBeNull();
        expect(toDeepSeekResult({ url: 'https://example.com' })).toBeNull();
        expect(toDeepSeekResult(null)).toBeNull();
    });
});

describe('DeepSeek result ranking', () => {
    const high = { title: 'a', url: 'https://a.example', source: 'a', score: 2, authority: 3 };
    const low = { title: 'b', url: 'https://b.example', source: 'b', score: 0.4, authority: 1 };

    it('drops clearly irrelevant results', () => {
        expect(rankDeepSeekResults([high, low], false)).toEqual([high]);
    });

    it('converges on authoritative sources only when enough of them survive', () => {
        const weak = { title: 'c', url: 'https://c.example', source: 'c', score: 2, authority: 1 };
        const authoritative = [
            high,
            { ...high, title: 'd', url: 'https://d.example' },
            { ...high, title: 'e', url: 'https://e.example' },
        ];

        // 「优先官方来源」是排序语义：高权威在前，低权威保留，
        // 而不是把低权威结果整个丢掉（中文长尾站点 authority 普遍 < 3）。
        const ranked = rankDeepSeekResults([weak, ...authoritative], true);
        expect(ranked).toHaveLength(4);
        expect(ranked[ranked.length - 1]?.title).toBe('c');

        // 高权威结果不够时保持原顺序
        expect(rankDeepSeekResults([high, weak], true)).toEqual([high, weak]);
        // 关闭时不重排
        expect(rankDeepSeekResults([weak, ...authoritative], false)).toEqual([
            weak,
            ...authoritative,
        ]);

        // 全部低于挡位时回退到未过滤集合，避免静默「0 条结果」
        const lowScores = [
            { ...high, title: 'l1', score: 0.4 },
            { ...high, title: 'l2', score: 0.2 },
        ];
        expect(rankDeepSeekResults(lowScores, false)).toHaveLength(2);
    });
});

describe('DeepSeek endpoint normalization', () => {
    it('accepts both documented endpoint forms', () => {
        // 官方同时接受 `/` 与 `/v1` 结尾，两者都不能拼成 `/v1/v1/...`。
        expect(buildDeepSeekToolsUrl('https://api.deepseek.com/v1')).toBe(
            'https://api.deepseek.com/v1/tools/search'
        );
        expect(buildDeepSeekToolsUrl('https://api.deepseek.com/')).toBe(
            'https://api.deepseek.com/v1/tools/search'
        );
        expect(buildDeepSeekToolsUrl('')).toBe('https://api.deepseek.com/v1/tools/search');
        expect(buildDeepSeekToolsUrl('https://relay.example.com/v1')).toBe(
            'https://relay.example.com/v1/tools/search'
        );
    });
});

describe('DeepSeek throttling and retries', () => {
    it('spaces queued requests by the configured interval', async () => {
        let now = 0;
        const sleeps: number[] = [];
        const scheduler = createRequestScheduler({
            minIntervalMs: 250,
            now: () => now,
            sleep: async (ms) => {
                sleeps.push(ms);
                now += ms;
            },
        });

        await expect(
            Promise.all([
                scheduler.run(async () => 'a'),
                scheduler.run(async () => 'b'),
                scheduler.run(async () => 'c'),
            ])
        ).resolves.toEqual(['a', 'b', 'c']);
        expect(sleeps).toEqual([250, 250]);
    });

    it('keeps the queue alive after a failed request', async () => {
        const scheduler = createRequestScheduler({
            minIntervalMs: 0,
            now: () => 0,
            sleep: async () => undefined,
        });

        await expect(scheduler.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow(
            'boom'
        );
        await expect(scheduler.run(async () => 'ok')).resolves.toBe('ok');
    });

    it('classifies retryable statuses per the official error table', () => {
        expect(isRetryableDeepSeekError(new WebSearchHttpError(408, 'Request Timeout'))).toBe(true);
        expect(isRetryableDeepSeekError(new WebSearchHttpError(429, 'Too Many Requests'))).toBe(
            true
        );
        expect(isRetryableDeepSeekError(new WebSearchHttpError(504, 'Gateway Timeout'))).toBe(true);
        expect(isRetryableDeepSeekError(new WebSearchHttpError(402, 'Payment Required'))).toBe(
            false
        );
        expect(isRetryableDeepSeekError(new WebSearchHttpError(404, 'Not Found'))).toBe(false);
        expect(isRetryableDeepSeekError(new Error('HTTP 500'))).toBe(false);
    });

    it('honours Retry-After and otherwise falls back to exponential backoff', () => {
        expect(
            deepSeekRetryDelayMs(
                0,
                new WebSearchHttpError(429, 'Too Many Requests', { retryAfterMs: 1200 }),
                () => 0
            )
        ).toBe(1200);
        expect(deepSeekRetryDelayMs(0, new WebSearchHttpError(500, 'Server Error'), () => 0)).toBe(
            500
        );
        expect(deepSeekRetryDelayMs(1, new WebSearchHttpError(500, 'Server Error'), () => 0)).toBe(
            1000
        );
    });

    it('retries retryable failures and stops on deterministic ones', async () => {
        const sleep = vi.fn(async () => undefined);
        let attempts = 0;

        await expect(
            runWithDeepSeekRetry(
                async () => {
                    attempts += 1;
                    if (attempts < 3) {
                        throw new WebSearchHttpError(429, 'Too Many Requests');
                    }
                    return 'ok';
                },
                { sleep, random: () => 0 }
            )
        ).resolves.toBe('ok');
        expect(attempts).toBe(3);
        expect(sleep).toHaveBeenCalledTimes(2);

        let hardAttempts = 0;
        await expect(
            runWithDeepSeekRetry(
                async () => {
                    hardAttempts += 1;
                    throw new WebSearchHttpError(402, 'Payment Required');
                },
                { sleep, random: () => 0 }
            )
        ).rejects.toThrow('HTTP 402');
        expect(hardAttempts).toBe(1);
    });
});

describe('DeepSeek search provider', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getSettingValueMock.mockResolvedValue(null);
    });

    it('searches through the documented endpoint with an inline key', async () => {
        getSettingValueMock.mockResolvedValueOnce(
            deepseekSettings({ apiKey: 'inline-key', endpoint: 'https://api.deepseek.com' })
        );
        tauriFetchMock.mockResolvedValueOnce(
            jsonResponse({
                results: [
                    {
                        title: 'DeepSeek V4 model released',
                        url: 'https://example.com/deepseek-v4',
                        summary: 'Model-facing summary',
                        snippet: 'UI snippet',
                        rerank_score: 2.4,
                        authority: 3,
                        site_name: 'Example News',
                    },
                ],
            })
        );

        const result = await executeWebSearchTool(
            { query: 'DeepSeek V4 发布' },
            {},
            createExecutionContext()
        );

        expect(result.isError).toBe(false);
        expect(String(tauriFetchMock.mock.calls[0]?.[0])).toBe(
            'https://api.deepseek.com/v1/tools/search'
        );
        expect(requestHeaders().Authorization).toBe('Bearer inline-key');
        expect(requestBody()).toMatchObject({
            query: 'DeepSeek V4 发布',
            count: 6,
            need_content: false,
        });
        expect(result.result).toContain('Source: Example News');
        expect(result.result).toContain('Snippet: Model-facing summary');
        expect(result.result).toContain('Score: 2.4 · Authority: 3');
        // 语义后缀展示的是搜索引擎，而不是命中的站点。
        expect(result.conversationSemantic).toEqual({
            action: 'search',
            target: 'DeepSeek V4 发布 · DeepSeek',
        });
    });

    it('keeps the provider in the semantic target when search fails', async () => {
        getSettingValueMock.mockResolvedValueOnce(
            deepseekSettings({ apiKey: 'inline-key', endpoint: 'https://api.deepseek.com' })
        );
        tauriFetchMock.mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 402));

        const result = await executeWebSearchTool(
            { query: 'DeepSeek 最新进展' },
            {},
            createExecutionContext()
        );

        expect(result.isError).toBe(true);
        expect(result.conversationSemantic).toEqual({
            action: 'search',
            target: 'DeepSeek 最新进展 · DeepSeek',
        });
    });

    it('falls back to an available provider when no DeepSeek key is configured', async () => {
        getSettingValueMock.mockResolvedValueOnce(deepseekSettings({}));
        tauriFetchMock.mockResolvedValueOnce(jsonResponse({ results: [] }));

        const result = await executeWebSearchTool(
            { query: 'DeepSeek 最新进展' },
            {},
            createExecutionContext()
        );

        expect(result.isError).toBe(false);
        expect(String(tauriFetchMock.mock.calls[0]?.[0])).toBe(
            'https://api.anysearch.com/v1/search'
        );
    });

    it('does not duplicate the version prefix for /v1 endpoints', async () => {
        getSettingValueMock.mockResolvedValueOnce(
            deepseekSettings({ apiKey: 'relay-key', endpoint: 'https://relay.example.com/v1' })
        );
        tauriFetchMock.mockResolvedValueOnce(jsonResponse({ results: [] }));

        await executeWebSearchTool({ query: 'relay search' }, {}, createExecutionContext());

        expect(String(tauriFetchMock.mock.calls[0]?.[0])).toBe(
            'https://relay.example.com/v1/tools/search'
        );
    });

    it('requests inline page content only when asked', async () => {
        getSettingValueMock.mockResolvedValueOnce(
            deepseekSettings({ apiKey: 'inline-key', endpoint: 'https://api.deepseek.com' })
        );
        tauriFetchMock.mockResolvedValueOnce(
            jsonResponse({
                results: [
                    {
                        title: 'DeepSeek V4',
                        url: 'https://example.com/v4',
                        content: '# DeepSeek V4\n\nBody',
                    },
                ],
            })
        );

        const result = await executeWebSearchTool(
            { query: 'DeepSeek V4', includeContent: true },
            {},
            createExecutionContext()
        );

        expect(requestBody().need_content).toBe(true);
        expect(result.result).toContain('Content: # DeepSeek V4');
    });

    it('passes domain and recency hints through the query operators', async () => {
        getSettingValueMock.mockResolvedValueOnce(
            deepseekSettings({ apiKey: 'inline-key', endpoint: 'https://api.deepseek.com' })
        );
        tauriFetchMock.mockResolvedValueOnce(jsonResponse({ results: [] }));

        await executeWebSearchTool(
            {
                query: 'OpenClaw 发布',
                domains: ['github.com', 'huggingface.co'],
                recencyDays: 30,
            },
            {},
            createExecutionContext()
        );

        expect(String(requestBody().query)).toContain('site:github.com OR site:huggingface.co');
        expect(String(requestBody().query)).toMatch(/after:\d{4}-\d{2}-\d{2}/);
    });

    it('translates deterministic API failures into actionable messages', () => {
        expect(
            describeDeepSeekFailure(new WebSearchHttpError(402, 'Payment Required')).message
        ).toBe('DeepSeek account has insufficient balance. (HTTP 402 Payment Required)');
        expect(
            describeDeepSeekFailure(new WebSearchHttpError(401, 'Unauthorized')).message
        ).toContain('API key is missing or invalid');
        // 未收录的状态码与普通错误保持原样。
        expect(describeDeepSeekFailure(new WebSearchHttpError(418, "I'm a teapot")).message).toBe(
            "HTTP 418 I'm a teapot"
        );
    });

    it('retries rate limited requests before succeeding', async () => {
        getSettingValueMock.mockResolvedValueOnce(
            deepseekSettings({ apiKey: 'inline-key', endpoint: 'https://api.deepseek.com' })
        );
        tauriFetchMock
            .mockResolvedValueOnce(
                jsonResponse({ error: { message: 'qps exceeded' } }, 429, { 'retry-after': '0' })
            )
            .mockResolvedValueOnce(
                jsonResponse({
                    results: [{ title: 'Recovered', url: 'https://example.com/ok' }],
                })
            );

        const result = await executeWebSearchTool(
            { query: 'rate limited query' },
            {},
            createExecutionContext()
        );

        expect(result.isError).toBe(false);
        expect(tauriFetchMock).toHaveBeenCalledTimes(2);
        expect(result.result).toContain('Recovered');
    });

    it('surfaces non-retryable billing failures without retrying', async () => {
        getSettingValueMock.mockResolvedValueOnce(
            deepseekSettings({ apiKey: 'inline-key', endpoint: 'https://api.deepseek.com' })
        );
        tauriFetchMock.mockResolvedValueOnce(
            jsonResponse({ error: { message: 'insufficient balance' } }, 402)
        );

        const result = await executeWebSearchTool(
            { query: 'anything' },
            {},
            createExecutionContext()
        );

        expect(result.isError).toBe(true);
        expect(result.status).toBe('error');
        expect(result.errorMessage).toContain('insufficient balance');
        expect(tauriFetchMock).toHaveBeenCalledTimes(1);
    });
});
