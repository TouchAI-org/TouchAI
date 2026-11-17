import {
    SEARCH_PROVIDER_METADATA,
    SEARCH_ROUTE_INTENTS,
    SEARCH_SOURCES,
    type SearchProviderId,
    type SearchRouteIntent,
    type SearchRoutingStrategy,
} from '@services/SettingsService/domain';

import type { AiToolDefinition } from '@/services/AgentService/contracts/tooling';

import {
    nonEmptyTrimmedStringSchema,
    optionalIntegerInRangeSchema,
    optionalTrimmedStringSchema,
    z,
} from '../../utils/toolSchema';
import { providerOptionSchema } from './providerOptions';

export const WEB_SEARCH_TOOL_ID = 'web_search';
export const WEB_SEARCH_INTENTS = SEARCH_ROUTE_INTENTS;
export const WEB_SEARCH_PROVIDERS = [
    'auto',
    'anysearch',
    'brave',
    'tavily',
    'exa',
    'firecrawl',
    'wikipedia',
    'openalex',
    'semantic_scholar',
    'github',
    'searxng',
    'deepseek',
    'keenable',
    'zhihu',
    'yuanbao',
    'grok',
    'doubao',
    'qianfan',
    'tinyfish',
    'serper',
] as const satisfies readonly SearchProviderId[];

export type WebSearchIntent = SearchRouteIntent;
export type WebSearchProvider = SearchProviderId;

export const DEFAULT_WEB_SEARCH_MAX_RESULTS = 6;
export const DEFAULT_WEB_SEARCH_TIMEOUT_MS = 15_000;

export const WEB_SEARCH_PROVIDER_RECOMMENDATIONS = Object.fromEntries(
    WEB_SEARCH_PROVIDERS.map((provider) => [
        provider,
        SEARCH_PROVIDER_METADATA[provider].recommendation,
    ])
) as Record<WebSearchProvider, string>;

export const webSearchArgsSchema = z.object({
    query: nonEmptyTrimmedStringSchema,
    provider: z.enum(WEB_SEARCH_PROVIDERS).optional(),
    intent: z.enum(WEB_SEARCH_INTENTS).optional(),
    source: z.enum(SEARCH_SOURCES).optional(),
    language: z.enum(['any', 'zh', 'en']).optional(),
    mode: z.enum(['fast', 'balanced', 'deep']).optional(),
    domains: z.array(nonEmptyTrimmedStringSchema).optional(),
    excludeDomains: z.array(nonEmptyTrimmedStringSchema).optional(),
    recencyDays: optionalIntegerInRangeSchema(1, 3650),
    maxResults: z.number().int().min(1).optional(),
    timeoutMs: optionalIntegerInRangeSchema(1_000, 300_000),
    description: optionalTrimmedStringSchema,
    includeContent: z.boolean().optional(),
    providerOptions: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
});

export const WEB_SEARCH_TOOL_DESCRIPTION = [
    'Discover web sources, optionally with page content. Use web_fetch for specific URLs and browser for interactive pages.',
    'Choose source for the kind of evidence needed, or provider to use one specific enabled engine. Explicit provider runs only that engine; auto follows the user strategy. Use providerOptions[provider] for documented native search parameters; the accepted keys for every enabled engine are enumerated in providerOptions.properties. Options stay with their named engine during fallback or fusion. If a capability exists only in one engine (X search, pagination, a vertical category), set provider explicitly and pass providerOptions; otherwise those parameters will not be sent.',
].join(' ');

function providerRecommendations(providers: readonly WebSearchProvider[]): string {
    return providers
        .map((provider) => `${provider}: ${WEB_SEARCH_PROVIDER_RECOMMENDATIONS[provider]}`)
        .join(' ');
}

export function buildWebSearchToolDescription(
    providers: readonly WebSearchProvider[] = WEB_SEARCH_PROVIDERS,
    strategy: SearchRoutingStrategy = 'capability'
): string {
    return [
        WEB_SEARCH_TOOL_DESCRIPTION,
        `User selection strategy: ${strategy}. ${strategy === 'model' ? 'Select a concrete provider based on its strengths; auto uses the configured default.' : 'Prefer provider=auto and source to respect this strategy; set a concrete provider only when a particular engine is needed.'}`,
        `Currently available providers: ${providers.join(', ')}.`,
        `Provider guidance: ${providerRecommendations(providers)}`,
    ].join(' ');
}

export function buildWebSearchToolInputSchema(
    providers: readonly WebSearchProvider[] = WEB_SEARCH_PROVIDERS
): AiToolDefinition['input_schema'] {
    return {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'Search query or research topic.',
            },
            provider: {
                type: 'string',
                enum: [...providers],
                description: `Optional search provider. Choose deliberately from the currently available list. ${providerRecommendations(providers)}`,
            },
            source: {
                type: 'string',
                enum: [...SEARCH_SOURCES],
                description:
                    'The kind of source you need. Prefer this over provider when you know the source type but not the engine.',
            },
            language: {
                type: 'string',
                enum: ['any', 'zh', 'en'],
                description: 'Source language preference. zh favors Chinese-native engines.',
            },
            mode: {
                type: 'string',
                enum: ['fast', 'balanced', 'deep'],
                description:
                    'Native speed/depth preset where supported. deep also combines providers if the user enabled deep-search fusion.',
            },
            intent: {
                type: 'string',
                enum: [...WEB_SEARCH_INTENTS],
                description: 'Legacy task hint. Prefer source when the source type is clear.',
            },
            domains: {
                type: 'array',
                description:
                    'Optional preferred public domains when supported by the selected provider.',
                items: { type: 'string' },
            },
            excludeDomains: {
                type: 'array',
                description:
                    'Optional public domains to exclude when supported by the selected provider.',
                items: { type: 'string' },
            },
            recencyDays: {
                type: 'integer',
                minimum: 1,
                maximum: 3650,
                description:
                    'Optional recency hint in days when supported by the selected provider.',
            },
            maxResults: {
                type: 'integer',
                minimum: 1,
                description:
                    'Maximum returned results. Each API request follows its documented page limit; providerOptions can select pages. Defaults to the user setting.',
            },
            timeoutMs: {
                type: 'integer',
                minimum: 1000,
                maximum: 300000,
                description:
                    'Per-engine timeout in milliseconds; defaults to the user setting (15000 initially). Increase for deep or Grok searches.',
            },
            includeContent: {
                type: 'boolean',
                description:
                    'Request inline page content from Exa, Tavily, Firecrawl, DeepSeek or Doubao Custom; Grok returns a cited synthesis. Zhihu, Yuanbao and Qianfan supply search excerpts, not full page text. Content and metadata use an 8000-character/item and 30000-character/response budget with visible truncation. Use web_fetch for page reading.',
            },
            providerOptions: {
                type: 'object',
                description:
                    'Native search parameters keyed by engine ID. Only enabled engines are accepted; each engine schema lists its supported keys. Values override mapped defaults. HTTP credentials and response transport stay managed by the app.',
                properties: Object.fromEntries(
                    providers
                        .filter((provider) => provider !== 'auto')
                        .flatMap((provider) => {
                            const schema = providerOptionSchema(provider);
                            return schema
                                ? [
                                      [
                                          provider,
                                          {
                                              type: 'object',
                                              description: `${provider} native options`,
                                              properties: schema,
                                              additionalProperties: true,
                                          },
                                      ],
                                  ]
                                : [];
                        })
                ),
                additionalProperties: false,
                examples: [
                    { exa: { type: 'neural', category: 'company' } },
                    { brave: { searchType: 'news', offset: 1 } },
                    { yuanbao: { Industry: 'news' } },
                ],
            },
            description: {
                type: 'string',
                description: 'Optional short semantic description for history display.',
            },
        },
        required: ['query'],
        additionalProperties: false,
    };
}

export const WEB_SEARCH_TOOL_INPUT_SCHEMA = buildWebSearchToolInputSchema();
