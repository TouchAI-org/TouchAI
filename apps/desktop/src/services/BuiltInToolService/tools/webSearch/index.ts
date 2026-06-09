import { getSettingValue } from '@database/queries';

import { createTauriFetch } from '@/services/AgentService/infrastructure/providers';
import {
    parseSearchSettingsConfig,
    SEARCH_PROVIDER_METADATA,
    SEARCH_SETTINGS_KEY,
    type SearchProviderId,
    type SearchSettingsConfig,
} from '@/stores/setting/sections/search';
import { normalizeOptionalString, truncateText } from '@/utils/text';

import {
    type BaseBuiltInToolExecutionContext,
    BuiltInTool,
    type BuiltInToolConversationSemantic,
    type BuiltInToolExecutionResult,
    type BuiltInToolGroup,
} from '../../types';
import {
    buildWebSearchToolDescription,
    buildWebSearchToolInputSchema,
    WEB_SEARCH_TOOL_DESCRIPTION,
    WEB_SEARCH_TOOL_ID,
    WEB_SEARCH_TOOL_INPUT_SCHEMA,
} from './constants';
import {
    createSearchSignal,
    formatWebSearchResults,
    parseWebSearchRequest,
    type WebSearchRequest,
    type WebSearchResult,
} from './helper';
import {
    getAvailableSearchProviders,
    getSearchProviderAdapter,
    isConfiguredSearchProvider,
} from './providers/adapters';
import type { WebSearchFetchJson } from './providers/types';

const tauriFetch = createTauriFetch();

function stripSearchActionPrefix(value: string): string {
    const original = value.trim();
    let current = original;

    for (let index = 0; index < 3; index += 1) {
        const next = current
            .replace(
                /^(?:搜索|查找|检索|查询|搜寻|寻找|调研|研究|了解|查看|收集|获取)(?:一下|有关|关于)?[\s:：,，。-]*/u,
                ''
            )
            .replace(
                /^(?:search(?:ing)?(?:\s+for)?|find|look\s+up|lookup|research|investigate|collect(?:\s+info(?:rmation)?)?(?:\s+about)?)\s*[:：-]?\s+/iu,
                ''
            )
            .trim();

        if (!next || next === current) {
            break;
        }
        current = next;
    }

    return current || original;
}

function buildSearchSemanticTarget(args: Record<string, unknown>): string {
    const description = normalizeOptionalString(args.description, { collapseWhitespace: true });
    const query = normalizeOptionalString(args.query, { collapseWhitespace: true });
    return truncateText(stripSearchActionPrefix(description ?? query ?? 'web'), 100);
}

function extractSearchResultSources(results: WebSearchResult[]): string[] {
    return results
        .map((result) => result.source.trim())
        .filter(Boolean)
        .filter((source, index, sources) => sources.indexOf(source) === index);
}

function formatSearchSourceSuffix(sources: string[]): string | null {
    if (sources.length === 0) {
        return null;
    }
    if (sources.length <= 2) {
        return sources.join('/');
    }
    return `${sources.slice(0, 2).join('/')} 等 ${sources.length} 个来源`;
}

function buildSearchSemantic(args: Record<string, unknown>): BuiltInToolConversationSemantic {
    return {
        action: 'search',
        target: buildSearchSemanticTarget(args),
    };
}

function buildSearchSemanticForResults(
    args: Record<string, unknown>,
    results: WebSearchResult[],
    provider: SearchProviderId
): BuiltInToolConversationSemantic {
    const resultSources = extractSearchResultSources(results);
    const sourceSuffix = formatSearchSourceSuffix(
        resultSources.length > 0 ? resultSources : [SEARCH_PROVIDER_METADATA[provider].sourceName]
    );
    const target = buildSearchSemanticTarget(args);
    return {
        action: 'search',
        target: sourceSuffix ? truncateText(`${target} · ${sourceSuffix}`, 100) : target,
    };
}

const fetchJson: WebSearchFetchJson = async (url, signal, init = {}) => {
    const response = await tauriFetch(url.toString(), {
        method: init.method ?? 'GET',
        headers: {
            Accept: 'application/json',
            'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
            'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
            ...(init.headers ?? {}),
        },
        body: init.body,
        signal,
    });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
    }

    return await response.json();
};

async function loadSearchSettings(): Promise<SearchSettingsConfig> {
    return parseSearchSettingsConfig(await getSettingValue({ key: SEARCH_SETTINGS_KEY }));
}

function routeProviderForSettings(
    request: WebSearchRequest,
    settings: SearchSettingsConfig
): SearchProviderId {
    if (request.intent && settings.intentRoutes[request.intent]) {
        const routedProvider = settings.intentRoutes[request.intent];
        if (routedProvider !== 'auto') {
            return routedProvider;
        }
    }

    return settings.defaultProvider;
}

function resolveExecutableSearchProvider(
    request: WebSearchRequest,
    settings: SearchSettingsConfig
): SearchProviderId {
    const provider =
        request.provider !== 'auto'
            ? request.provider
            : routeProviderForSettings(request, settings);
    if (getSearchProviderAdapter(provider) && isConfiguredSearchProvider(provider, settings)) {
        return provider;
    }

    if (isConfiguredSearchProvider('anysearch', settings)) {
        return 'anysearch';
    }

    if (request.intent === 'academic') {
        return 'openalex';
    }

    if (request.intent === 'technical') {
        return 'github';
    }

    return 'wikipedia';
}

async function runSearchProvider(
    request: WebSearchRequest,
    settings: SearchSettingsConfig,
    signal: AbortSignal,
    provider: SearchProviderId
): Promise<WebSearchResult[]> {
    const adapter = getSearchProviderAdapter(provider);
    if (!adapter) {
        return [];
    }

    return adapter.search({ request, settings, signal, fetchJson });
}

function applySearchSettingsDefaults(
    args: Record<string, unknown>,
    request: WebSearchRequest,
    settings: SearchSettingsConfig
): WebSearchRequest {
    return {
        ...request,
        maxResults:
            typeof args.maxResults === 'number' && Number.isFinite(args.maxResults)
                ? request.maxResults
                : settings.maxResults,
        timeoutMs:
            typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs)
                ? request.timeoutMs
                : settings.timeoutMs,
    };
}

export async function executeWebSearchTool(
    args: Record<string, unknown>,
    config: Record<string, never>,
    context: BaseBuiltInToolExecutionContext
): Promise<BuiltInToolExecutionResult> {
    void config;
    const searchSettings = await loadSearchSettings();
    const request = applySearchSettingsDefaults(args, parseWebSearchRequest(args), searchSettings);
    const provider = resolveExecutableSearchProvider(request, searchSettings);
    const { signal, cleanup } = createSearchSignal(context.signal, request.timeoutMs);

    try {
        const results = await runSearchProvider(request, searchSettings, signal, provider);
        const limitedResults = results.slice(0, request.maxResults);
        return {
            result: formatWebSearchResults(request, limitedResults),
            isError: false,
            status: 'success',
            conversationSemantic: buildSearchSemanticForResults(args, limitedResults, provider),
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
            result: `Web search failed\nQuery: ${request.query}\nReason: ${errorMessage}`,
            isError: true,
            status:
                error instanceof DOMException && error.name === 'TimeoutError'
                    ? 'timeout'
                    : 'error',
            errorMessage,
            conversationSemantic: buildSearchSemanticForResults(args, [], provider),
        };
    } finally {
        cleanup();
    }
}

class WebSearchTool extends BuiltInTool<Record<string, never>> {
    readonly id = WEB_SEARCH_TOOL_ID;
    readonly displayName = 'WebSearch';
    readonly description = WEB_SEARCH_TOOL_DESCRIPTION;
    readonly inputSchema = WEB_SEARCH_TOOL_INPUT_SCHEMA;
    readonly defaultConfig = {};

    override async buildToolDefinition(namespacedName: string) {
        const settings = await loadSearchSettings();
        const providers = getAvailableSearchProviders(settings);
        return {
            name: namespacedName,
            description: buildWebSearchToolDescription(providers),
            input_schema: buildWebSearchToolInputSchema(providers),
        };
    }

    override buildConversationSemantic(args: Record<string, unknown>) {
        return buildSearchSemantic(args);
    }

    override execute(
        args: Record<string, unknown>,
        config: Record<string, never>,
        context: BaseBuiltInToolExecutionContext
    ) {
        return executeWebSearchTool(args, config, context);
    }
}

export const webSearchTool = new WebSearchTool();
export const builtInTools: BuiltInToolGroup = [webSearchTool];
