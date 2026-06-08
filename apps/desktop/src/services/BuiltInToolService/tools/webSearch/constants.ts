import type { AiToolDefinition } from '@/services/AgentService/contracts/tooling';

import {
    integerInRangeSchema,
    nonEmptyTrimmedStringSchema,
    optionalIntegerInRangeSchema,
    optionalTrimmedStringSchema,
    z,
} from '../../utils/toolSchema';

export const WEB_SEARCH_TOOL_ID = 'web_search';
export const WEB_SEARCH_INTENTS = [
    'general',
    'academic',
    'technical',
    'official',
    'news',
] as const;

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
] as const;

export type WebSearchIntent = (typeof WEB_SEARCH_INTENTS)[number];
export type WebSearchProvider = (typeof WEB_SEARCH_PROVIDERS)[number];

export const DEFAULT_WEB_SEARCH_MAX_RESULTS = 6;
export const DEFAULT_WEB_SEARCH_TIMEOUT_MS = 15_000;

export const WEB_SEARCH_PROVIDER_RECOMMENDATIONS: Record<WebSearchProvider, string> = {
    auto: 'Follow user settings; by default this resolves to anysearch for general discovery.',
    anysearch: 'Recommended default for general research, broad web discovery, newsy topics, and zero/low-config search.',
    brave: 'Fresh broad web/news discovery when a Brave Search API key is configured.',
    tavily: 'Research-style broad web search with concise snippets when configured.',
    exa: 'Semantic web discovery for companies, products, articles, and high-signal pages when configured.',
    firecrawl: 'Search plus crawl-oriented discovery when configured.',
    wikipedia: 'Encyclopedic background only; avoid using it as the only source for recent or project-specific research.',
    openalex: 'Scholarly papers, authors, institutions, and academic metadata.',
    semantic_scholar: 'Academic paper search and abstracts, especially AI/CS papers.',
    github: 'Repositories, releases, issues, code projects, maintainers, and project activity.',
    searxng: 'Configured metasearch instance when the user provides one.',
};

export const webSearchArgsSchema = z.object({
    query: nonEmptyTrimmedStringSchema,
    provider: z.enum(WEB_SEARCH_PROVIDERS).optional(),
    intent: z.enum(WEB_SEARCH_INTENTS).optional(),
    domains: z.array(nonEmptyTrimmedStringSchema).optional(),
    recencyDays: optionalIntegerInRangeSchema(1, 3650),
    maxResults: integerInRangeSchema(1, 10).optional(),
    timeoutMs: optionalIntegerInRangeSchema(1_000, 60_000),
    description: optionalTrimmedStringSchema,
});

export const WEB_SEARCH_TOOL_DESCRIPTION = [
    'Search for candidate web sources through one consolidated research entry point.',
    'Use this for discovery only; use web_fetch to read specific URLs and browser for rendered or interactive pages.',
    'For general research, use anysearch by default; auto follows user settings and normally resolves to anysearch. Choose a specialized provider only when one source type is clearly best: github for repositories/releases/issues, openalex or semantic_scholar for papers, wikipedia for encyclopedic background, and searxng for a configured metasearch instance.',
].join(' ');

function providerRecommendations(providers: readonly WebSearchProvider[]): string {
    return providers
        .map((provider) => `${provider}: ${WEB_SEARCH_PROVIDER_RECOMMENDATIONS[provider]}`)
        .join(' ');
}

export function buildWebSearchToolDescription(
    providers: readonly WebSearchProvider[] = WEB_SEARCH_PROVIDERS
): string {
    return [
        WEB_SEARCH_TOOL_DESCRIPTION,
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
            intent: {
                type: 'string',
                enum: [...WEB_SEARCH_INTENTS],
                description:
                    'Optional search intent used as a secondary hint. Choose provider first when the best source is clear.',
            },
            domains: {
                type: 'array',
                description: 'Optional preferred public domains when supported by the selected provider.',
                items: { type: 'string' },
            },
            recencyDays: {
                type: 'integer',
                description: 'Optional recency hint in days when supported by the selected provider.',
            },
            maxResults: {
                type: 'integer',
                minimum: 1,
                maximum: 10,
                description: 'Maximum number of candidate results. Defaults to 6.',
            },
            timeoutMs: {
                type: 'integer',
                minimum: 1000,
                maximum: 60000,
                description: 'Optional timeout in milliseconds. Defaults to 15000.',
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
