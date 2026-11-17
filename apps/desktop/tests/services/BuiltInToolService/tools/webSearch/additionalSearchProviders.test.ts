import { beforeEach, describe, expect, it, vi } from 'vitest';

import { executeWebSearchTool, webSearchTool } from '@/services/BuiltInToolService/tools/webSearch';
import { parseSearchSettingsConfig, serializeSearchSettingsConfig } from '@/services/SettingsService/domain';

const { readSettings, fetchMock } = vi.hoisted(() => ({ readSettings: vi.fn(), fetchMock: vi.fn() }));
vi.mock('@/services/BuiltInToolService/settingsReader', () => ({ readEffectiveSettingValue: readSettings }));
vi.mock('@/services/HttpService', () => ({ createTauriFetch: () => fetchMock, cancelResponseBody: vi.fn() }));
const ids = ['doubao', 'qianfan', 'tinyfish', 'serper'] as const;
const context = () => ({ signal: new AbortController().signal, callId: 'additional-providers', iteration: 1 });
const response = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
const body = () => JSON.parse(String(fetchMock.mock.calls[fetchMock.mock.calls.length - 1]?.[1]?.body));

beforeEach(() => {
    vi.clearAllMocks();
    readSettings.mockResolvedValue(JSON.stringify({ providers: Object.fromEntries(ids.map(id => [id, { enabled: true, apiKey: 'fixture-key' }])) }));
});

describe('user configures additional search engines', () => {
    it('user retains existing settings while new keyed engines start disabled', () => {
        const settings = parseSearchSettingsConfig(JSON.stringify({ maxResults: 17, providers: { deepseek: { enabled: true, apiKey: 'existing' } } }));
        const saved = JSON.parse(serializeSearchSettingsConfig(settings));
        expect(saved.maxResults).toBe(17);
        expect(saved.providers.deepseek.apiKey).toBe('existing');
        for (const id of ids) expect(saved.providers[id]).toEqual({ enabled: false, apiKey: '', endpoint: '' });
    });
    it('user sees the configured engines offered to the model', async () => {
        const definition = await webSearchTool.buildToolDefinition('builtin__web_search');
        for (const id of ids) expect(definition.description).toContain(`${id}:`);
    });
    it.each(ids)('user cannot enable %s without its required key', id => {
        const settings = parseSearchSettingsConfig(JSON.stringify({ providers: { [id]: { enabled: true } } }));
        expect(settings.providers[id]?.enabled).toBe(false);
    });
});

describe('user searches with the additional engines', () => {
    it('user receives Doubao summaries and optional full content with precise filters', async () => {
        fetchMock.mockResolvedValue(response({ Result: { WebResults: [{ Title: 'Article', Url: 'https://example.com/article', Summary: 'Relevant summary', Snippet: 'Short snippet', Content: 'Whole page', PublishTime: '2026-11-17', AuthInfoLevel: 2, InlineImages: [{ ImageUrl: 'https://example.com/i.png' }] }] } }));
        const result = await executeWebSearchTool({ query: 'article', provider: 'doubao', includeContent: true, domains: ['example.com'], excludeDomains: ['other.com'], recencyDays: 3, maxResults: 80, providerOptions: { doubao: { Industry: 'gov' } } }, {}, context());
        expect(fetchMock.mock.calls[0]?.[0]).toBe('https://open.feedcoopapi.com/search_api/web_search');
        expect(body()).toMatchObject({ Count: 50, Filter: { Sites: 'example.com', BlockHosts: 'other.com' }, ContentFormats: 'markdown', Industry: 'gov' });
        expect(body().TimeRange).toMatch(/^\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}$/);
        expect(result.result).toContain('Relevant summary');
        expect(result.result).toContain('Content: Whole page');
        expect(result.result).toContain('InlineImages');
    });
    it('user can select Doubao Global image search without losing image metadata', async () => {
        fetchMock.mockResolvedValue(response({ Result: { ErrorCode: 0, Documents: [{ Title: 'Photo', Url: 'https://example.com/photo', Snippet: [{ Type: 'image', Image: { ImageUrl: 'https://example.com/p.png' } }], HostInfo: { Hostname: 'Example' }, DocumentInfo: { PublishTime: '2026-11-17' } }] } }));
        const result = await executeWebSearchTool({ query: 'photo', provider: 'doubao', providerOptions: { doubao: { edition: 'global', SearchType: 'image', ImageFilter: { ShortEdgePixelMin: 512 } } } }, {}, context());
        expect(fetchMock.mock.calls[0]?.[0]).toBe('https://open.feedcoopapi.com/search_api/global_search');
        expect(body()).toMatchObject({ SearchType: 'image', ImageFilter: { ShortEdgePixelMin: 512 } });
        expect(body()).not.toHaveProperty('edition');
        expect(body()).not.toHaveProperty('Count');
        expect(result.result).toContain('https://example.com/p.png');
    });
    it('user sees a Doubao application failure instead of an empty result', async () => {
        fetchMock.mockResolvedValue(response({ ResponseMetadata: { Error: { Code: '10406', Message: 'Quota exhausted' } }, Result: null }));
        const result = await executeWebSearchTool({ query: 'q', provider: 'doubao' }, {}, context());
        expect(result.isError).toBe(true);
        expect(result.result).toContain('10406');
    });
    it('user receives a clear error for filters that Doubao Global cannot enforce', async () => {
        const result = await executeWebSearchTool({ query: 'q', provider: 'doubao', domains: ['example.com'], providerOptions: { doubao: { edition: 'global' } } }, {}, context());
        expect(result.isError).toBe(true);
        expect(result.result).toContain('Custom');
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it('user receives Qianfan evidence without treating its excerpt as a full page', async () => {
        fetchMock.mockResolvedValue(response({ references: [{ title: 'Reference', url: 'https://example.com/q', snippet: 'Relevant excerpt', content: 'Same excerpt', website: 'Example', date: '2026-11-17', authority_score: 0.9, rerank_score: 0.8, web_extensions: { images: [] } }] }));
        const result = await executeWebSearchTool({ query: 'q', provider: 'qianfan', domains: ['example.com'], excludeDomains: ['other.com'], recencyDays: 2, includeContent: true, providerOptions: { qianfan: { edition: 'turbo', chunks_per_doc: 3 } } }, {}, context());
        expect(fetchMock.mock.calls[0]?.[0]).toBe('https://qianfan.baidubce.com/v2/ai_search/web_search');
        expect(body()).toMatchObject({ search_source: 'baidu_search_v2', edition: 'turbo', chunks_per_doc: 3, search_filter: { match: { site: ['example.com'] }, range: { page_time: { gte: expect.any(String), lte: expect.any(String) } } }, block_websites: ['other.com'] });
        expect(result.result).toContain('Relevant excerpt');
        expect(result.result).not.toContain('Content:');
        expect(result.result).toContain('authority_score');
    });
    it('user sees a Qianfan application error without retrying another engine', async () => {
        fetchMock.mockResolvedValue(response({ code: 'InvalidArgument', message: 'Invalid filter' }));
        const result = await executeWebSearchTool({ query: 'q', provider: 'qianfan' }, {}, context());
        expect(result.isError).toBe(true);
        expect(result.result).toContain('InvalidArgument');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    it('user gets TinyFish academic results with native pagination and domain filters', async () => {
        fetchMock.mockResolvedValue(response({ query: 'papers', results: [{ position: 1, site_name: 'Journal', title: 'Paper', url: 'https://example.com/p', snippet: 'Abstract', authors: ['A'], pdf_url: 'https://example.com/p.pdf', cited_by_count: 42 }], total_results: 1, page: 2 }));
        const result = await executeWebSearchTool({ query: 'papers', provider: 'tinyfish', source: 'academic', domains: ['example.com', 'arxiv.org'], recencyDays: 1, providerOptions: { tinyfish: { page: 2, purpose: 'Compare papers' } } }, {}, context());
        const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
        expect(url.origin).toBe('https://api.search.tinyfish.ai');
        expect(url.searchParams.get('include_domains')).toBe('example.com,arxiv.org');
        expect(url.searchParams.get('domain_type')).toBe('research_paper');
        expect(url.searchParams.get('page')).toBe('2');
        expect(url.searchParams.get('recency_minutes')).toBe('1440');
        expect(fetchMock.mock.calls[0]?.[1]?.headers['X-API-Key']).toBe('fixture-key');
        expect(result.result).toContain('cited_by_count');
    });
    it('user can replace TinyFish relative recency with a native date range', async () => {
        fetchMock.mockResolvedValue(response({ results: [] }));
        await executeWebSearchTool({ query: 'q', provider: 'tinyfish', recencyDays: 7, providerOptions: { tinyfish: { after_date: '2026-11-01' } } }, {}, context());
        const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
        expect(url.searchParams.get('after_date')).toBe('2026-11-01');
        expect(url.searchParams.has('recency_minutes')).toBe(false);
    });
    it('user receives Serper news sources with localization and native paging', async () => {
        fetchMock.mockResolvedValue(response({ news: [{ title: 'News', link: 'https://example.com/news', snippet: 'News excerpt', date: '2 hours ago', imageUrl: 'https://example.com/news.png' }] }));
        const result = await executeWebSearchTool({ query: 'news', provider: 'serper', source: 'news', language: 'zh', domains: ['example.com'], providerOptions: { serper: { gl: 'cn', page: 2 } } }, {}, context());
        expect(fetchMock.mock.calls[0]?.[0]).toBe('https://google.serper.dev/news');
        expect(fetchMock.mock.calls[0]?.[1]?.headers['X-API-KEY']).toBe('fixture-key');
        expect(body()).toMatchObject({ q: 'news (site:example.com)', hl: 'zh-cn', gl: 'cn', page: 2 });
        expect(result.result).toContain('News excerpt');
    });
    it('user keeps Serper image sources and rich web cards', async () => {
        fetchMock.mockResolvedValue(response({ images: [{ title: 'Photo', link: 'https://example.com/gallery', imageUrl: 'https://example.com/p.jpg', imageWidth: 1920 }], knowledgeGraph: { title: 'Photo subject' } }));
        const result = await executeWebSearchTool({ query: 'photo', provider: 'serper', providerOptions: { serper: { searchType: 'images' } } }, {}, context());
        expect(fetchMock.mock.calls[0]?.[0]).toBe('https://google.serper.dev/images');
        expect(body()).not.toHaveProperty('searchType');
        expect(result.result).toContain('https://example.com/p.jpg');
        expect(result.result).toContain('knowledgeGraph');
    });
    it.each(ids)('user sees an authentication error when %s rejects its key', async provider => {
        fetchMock.mockResolvedValue(response({}, 401));
        const result = await executeWebSearchTool({ query: 'q', provider }, {}, context());
        expect(result.isError).toBe(true);
        expect(result.result).toContain('401');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    it.each(ids)('user gets an empty result when %s returns no sources', async provider => {
        fetchMock.mockResolvedValue(response({ Result: { WebResults: [] }, results: [], references: [], organic: [] }));
        const result = await executeWebSearchTool({ query: 'q', provider }, {}, context());
        expect(result.isError).toBe(false);
        expect(result.result).toContain('No candidate sources');
    });
});
