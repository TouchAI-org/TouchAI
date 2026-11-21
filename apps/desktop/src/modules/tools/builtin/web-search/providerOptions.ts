import type { SearchProviderId } from './configuration';

/** JSON Schema fragments for each engine's native search parameters. */
export interface ProviderOptionProperty {
    type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
    description: string;
    enum?: readonly string[];
    minimum?: number;
    maximum?: number;
    items?: { type: string; enum?: readonly string[] };
    properties?: Record<string, ProviderOptionProperty>;
    additionalProperties?: boolean;
}

export const SEARCH_PROVIDER_OPTION_SCHEMAS: Partial<
    Record<SearchProviderId, Record<string, ProviderOptionProperty>>
> = {
    anysearch: {
        tag: {
            type: 'string',
            description: 'Vertical capability tag, e.g. news, finance, code.doc, academic.',
        },
        params: {
            type: 'object',
            description: 'Parameters required by the chosen tag.',
            additionalProperties: true,
        },
    },
    exa: {
        type: {
            type: 'string',
            enum: ['auto', 'neural', 'fast', 'deep', 'keyword'],
            description: 'Retrieval mode.',
        },
        category: {
            type: 'string',
            enum: [
                'company',
                'research paper',
                'news',
                'pdf',
                'github',
                'tweet',
                'personal site',
                'linkedin profile',
            ],
            description: 'Restrict to a content category.',
        },
        contents: {
            type: 'object',
            description: 'Exa contents options, e.g. { text: { maxCharacters } }.',
        },
        livecrawl: {
            type: 'string',
            enum: ['never', 'fallback', 'always', 'preferred'],
            description: 'Live crawling policy.',
        },
    },
    tavily: {
        search_depth: {
            type: 'string',
            enum: ['basic', 'advanced', 'fast', 'ultra-fast'],
            description: 'Search depth.',
        },
        topic: {
            type: 'string',
            enum: ['general', 'news', 'finance'],
            description: 'Topic vertical.',
        },
        include_answer: { type: 'boolean', description: 'Include Tavily answer.' },
        include_images: { type: 'boolean', description: 'Include image results.' },
        chunks_per_source: { type: 'integer', minimum: 1, description: 'Snippets per source.' },
        days: { type: 'integer', minimum: 1, description: 'News lookback in days.' },
    },
    keenable: {
        mode: {
            type: 'string',
            enum: ['pro', 'realtime'],
            description: 'pro for depth, realtime for latency.',
        },
        query_time: {
            type: 'string',
            description: 'Point-in-time index snapshot, e.g. 7d or an ISO date.',
        },
        acquired_after: {
            type: 'string',
            description: 'Only pages indexed after this date or relative delta.',
        },
        acquired_before: {
            type: 'string',
            description: 'Only pages indexed before this date or relative delta.',
        },
        published_before: { type: 'string', description: 'Only pages published before this date.' },
        snippet_max_length: {
            type: 'integer',
            minimum: 50,
            maximum: 2000,
            description: 'Snippet length.',
        },
    },
    zhihu: {
        searchType: {
            type: 'string',
            enum: ['global', 'zhihu'],
            description: 'Whole web or Zhihu only.',
        },
        SearchDB: {
            type: 'string',
            enum: ['all', 'realtime', 'static'],
            description: 'Index selection for global search.',
        },
        Filter: { type: 'string', description: 'host=="a" AND publish_time>=timestamp.' },
        SortBy: { type: 'string', description: 'Site search sort, e.g. VoteUpCount:desc.' },
    },
    yuanbao: {
        Mode: { type: 'integer', description: '0 public web, 1 authoritative vertical, 2 mixed.' },
        Industry: {
            type: 'string',
            enum: ['gov', 'news', 'acad', 'finance'],
            description: 'Vertical industry.',
        },
        Site: { type: 'string', description: 'Single site or exclude:a|b.' },
        Deeplinks: { type: 'boolean', description: 'Return attachment sub-links (flagship).' },
    },
    grok: {
        model: { type: 'string', description: 'Grok model id.' },
        tools: {
            type: 'array',
            items: { type: 'object' },
            description: 'xAI tools, e.g. web_search and x_search.',
        },
        max_output_tokens: { type: 'integer', minimum: 128, description: 'Response token cap.' },
        temperature: {
            type: 'number',
            minimum: 0,
            maximum: 2,
            description: 'Sampling temperature.',
        },
    },
    github: {
        searchType: {
            type: 'string',
            enum: ['repositories', 'issues', 'code', 'commits', 'users'],
            description: 'Search kind.',
        },
        page: { type: 'integer', minimum: 1, description: 'Result page.' },
        sort: { type: 'string', description: 'Sort field, e.g. stars.' },
        order: { type: 'string', enum: ['asc', 'desc'], description: 'Sort direction.' },
    },
    brave: {
        searchType: {
            type: 'string',
            enum: ['web', 'news', 'images', 'videos'],
            description: 'Brave vertical.',
        },
        offset: { type: 'integer', minimum: 0, maximum: 9, description: 'Page offset.' },
        safesearch: {
            type: 'string',
            enum: ['off', 'moderate', 'strict'],
            description: 'Safe search.',
        },
    },
    openalex: {
        filter: { type: 'string', description: 'OpenAlex filter expression.' },
        sort: { type: 'string', description: 'Sort expression, e.g. cited_by_count:desc.' },
        page: { type: 'integer', minimum: 1, description: 'Result page.' },
    },
    semantic_scholar: {
        fields: { type: 'string', description: 'Comma-separated fields.' },
        offset: { type: 'integer', minimum: 0, description: 'Result offset.' },
        year: { type: 'string', description: 'Year or range, e.g. 2024-2026.' },
        venue: { type: 'string', description: 'Venue filter.' },
    },
    searxng: {
        engines: { type: 'string', description: 'Comma-separated engine names.' },
        categories: { type: 'string', description: 'Comma-separated categories.' },
        pageno: { type: 'integer', minimum: 1, description: 'Result page.' },
        time_range: { type: 'string', description: 'day, week, month or year.' },
        language: { type: 'string', description: 'Language code or auto.' },
    },
    wikipedia: {
        namespace: { type: 'integer', minimum: 0, description: 'MediaWiki namespace.' },
        limit: { type: 'integer', minimum: 1, description: 'Result limit.' },
    },
    doubao: {
        edition: {
            type: 'string',
            enum: ['custom', 'global'],
            description: 'Custom or Global edition.',
        },
        SearchType: {
            type: 'string',
            enum: ['web', 'image', 'visual'],
            description: 'Vertical type.',
        },
        Industry: {
            type: 'string',
            enum: ['gov', 'news', 'acad', 'finance'],
            description: 'Industry filter.',
        },
        Filter: {
            type: 'object',
            description: 'Native filter object, including Sites and BlockHosts.',
        },
        ContentFormats: { type: 'string', description: 'Inline content format, e.g. markdown.' },
        ImageFilter: { type: 'object', description: 'Image-specific filter object.' },
    },
    qianfan: {
        edition: { type: 'string', enum: ['standard', 'turbo'], description: 'Search edition.' },
        resource_type_filter: {
            type: 'array',
            items: { type: 'object' },
            description: 'Vertical result types and top_k.',
        },
        search_filter: { type: 'object', description: 'Native site/date filter object.' },
        chunks_per_doc: { type: 'integer', minimum: 1, description: 'Snippets per document.' },
        search_source: {
            type: 'string',
            description: 'Native search source, e.g. baidu_search_v2.',
        },
    },
    tinyfish: {
        purpose: { type: 'string', description: 'Natural-language purpose used for ranking.' },
        domain_type: {
            type: 'string',
            enum: ['news', 'research_paper'],
            description: 'Restrict to a source family.',
        },
        after_date: { type: 'string', description: 'Published on or after YYYY-MM-DD.' },
        before_date: { type: 'string', description: 'Published on or before YYYY-MM-DD.' },
        page: { type: 'integer', minimum: 1, description: 'Result page.' },
        pub_year_min: { type: 'integer', minimum: 1900, description: 'Earliest publication year.' },
        pub_year_max: { type: 'integer', minimum: 1900, description: 'Latest publication year.' },
    },
    serper: {
        searchType: {
            type: 'string',
            enum: [
                'search',
                'news',
                'images',
                'videos',
                'places',
                'shopping',
                'scholar',
                'patents',
            ],
            description: 'Google vertical.',
        },
        gl: { type: 'string', description: 'Country code, e.g. cn.' },
        hl: { type: 'string', description: 'Interface language, e.g. zh-cn.' },
        page: { type: 'integer', minimum: 1, description: 'Result page.' },
        num: { type: 'integer', minimum: 1, description: 'Results per page.' },
        tbs: { type: 'string', description: 'Google time filter, e.g. qdr:d7.' },
    },
    firecrawl: {
        sources: {
            type: 'array',
            items: { type: 'string', enum: ['web', 'news', 'images'] },
            description: 'Result sources.',
        },
        tbs: { type: 'string', description: 'Time filter, e.g. qdr:d7.' },
        onlyMainContent: { type: 'boolean', description: 'Return main content only.' },
        location: { type: 'string', description: 'Geographic location.' },
    },
};

export function providerOptionSchema(
    provider: SearchProviderId
): Record<string, ProviderOptionProperty> | undefined {
    return SEARCH_PROVIDER_OPTION_SCHEMAS[provider];
}
