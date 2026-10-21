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
import {
    type WebSearchFetchJson,
    type WebSearchFetchText,
    WebSearchHttpError,
} from './providers/types';
import { webSearchHostname, type WebSearchSourcesPayload } from './sources';

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

function buildSearchSemantic(args: Record<string, unknown>): BuiltInToolConversationSemantic {
    return {
        action: 'search',
        target: buildSearchSemanticTarget(args),
    };
}

function buildSearchSemanticForResults(
    args: Record<string, unknown>,
    provider: SearchProviderId
): BuiltInToolConversationSemantic {
    // 后缀展示的是「用哪个搜索引擎搜的」，而不是命中的站点列表。
    const target = buildSearchSemanticTarget(args);
    return {
        action: 'search',
        target: truncateText(`${target} · ${SEARCH_PROVIDER_METADATA[provider].sourceName}`, 100),
    };
}

/**
 * 解析卡片的站点名。
 *
 * `WebSearchResult.source` 在不同 provider 下语义不一致：
 * DeepSeek 填的是真实 `site_name`（如 `Example News`），
 * 而 anysearch / brave / tavily 等填的是**自己的品牌名**（`AnySearch`、`Brave`），
 * 直接展示会让每张卡片都叫同一个名字。
 * 这里只在它确实区别于 provider 白标时才当作站点名，否则从 URL 取域名。
 */
function resolveSourceSiteName(result: WebSearchResult, provider: SearchProviderId): string {
    const explicit = result.source?.trim();
    const brand = SEARCH_PROVIDER_METADATA[provider].sourceName.trim();
    if (explicit && explicit.toLowerCase() !== brand.toLowerCase()) {
        return explicit;
    }

    return webSearchHostname(result.url) || brand;
}

/** 卡片与引用会把这个 URL 直接绑到 `<a :href>`，非 http(s) 一律不收。 */
function isRenderableSourceUrl(url: string): boolean {
    return /^https?:\/\//i.test(url.trim());
}

/** 把搜索结果打包成前端可渲染的结构化载荷。 */
function buildSearchStructuredPayload(
    request: WebSearchRequest,
    results: WebSearchResult[],
    provider: SearchProviderId
): WebSearchSourcesPayload {
    const sources = results
        .filter((result) => isRenderableSourceUrl(result.url))
        .map((result, index) => ({
            id: `${provider}-${index + 1}`,
            index: index + 1,
            title: result.title,
            url: result.url,
            snippet: result.snippet,
            siteName: resolveSourceSiteName(result, provider),
            favicon: result.favicon,
            publishedAt: result.publishedAt,
            score: result.score,
            authority: result.authority,
        }));

    return {
        query: request.query,
        provider,
        status: 'done',
        sources,
    };
}

/**
 * 解析服务端 `Retry-After`；支持秒数与 HTTP 日期两种形式。
 */
function parseRetryAfterMs(value: string | null): number | undefined {
    const trimmed = value?.trim();
    if (!trimmed) {
        return undefined;
    }

    const seconds = Number(trimmed);
    if (Number.isFinite(seconds)) {
        return Math.max(0, seconds * 1000);
    }

    const date = Date.parse(trimmed);
    return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
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
        throw new WebSearchHttpError(response.status, response.statusText, {
            retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
        });
    }

    return await response.json();
};

const fetchText: WebSearchFetchText = async (url, signal, init = {}) => {
    const response = await tauriFetch(url.toString(), {
        method: init.method ?? 'GET',
        headers: {
            'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
            'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
            ...(init.headers ?? {}),
        },
        body: init.body,
        signal,
    });

    if (!response.ok) {
        throw new WebSearchHttpError(response.status, response.statusText, {
            retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
        });
    }

    return await response.text();
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
    const availableProviders = getAvailableSearchProviders(settings).filter(
        (provider) => provider !== 'auto'
    );
    const provider =
        request.provider !== 'auto'
            ? request.provider
            : routeProviderForSettings(request, settings);
    if (getSearchProviderAdapter(provider) && isConfiguredSearchProvider(provider, settings)) {
        return provider;
    }

    if (availableProviders.includes('anysearch')) {
        return 'anysearch';
    }

    if (request.intent === 'academic' && availableProviders.includes('openalex')) {
        return 'openalex';
    }

    if (request.intent === 'technical' && availableProviders.includes('github')) {
        return 'github';
    }

    return availableProviders[0] ?? 'auto';
}

async function runSearchProvider(
    request: WebSearchRequest,
    settings: SearchSettingsConfig,
    signal: AbortSignal,
    provider: SearchProviderId
): Promise<WebSearchResult[]> {
    const adapter = getSearchProviderAdapter(provider);
    if (!adapter) {
        throw new Error('No enabled search provider is configured.');
    }

    return adapter.search({ request, settings, signal, fetchJson, fetchText });
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
            conversationSemantic: buildSearchSemanticForResults(args, provider),
            structuredPayload: {
                kind: 'web_search_sources',
                ...buildSearchStructuredPayload(request, limitedResults, provider),
            },
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
            conversationSemantic: buildSearchSemanticForResults(args, provider),
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
