// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { parseSearchSettingsConfig, SEARCH_SETTINGS_KEY } from '@services/SettingsService/domain';

import { t, tt } from '@/i18n';
import { cancelResponseBody, createTauriFetch } from '@/services/HttpService';
import { normalizeOptionalString, truncateText } from '@/utils/text';

import { readEffectiveSettingValue } from '../../settingsReader';
import {
    type BaseBuiltInToolExecutionContext,
    BuiltInTool,
    type BuiltInToolConversationSemantic,
    type BuiltInToolExecutionResult,
    type BuiltInToolGroup,
} from '../../types';
import {
    DEFAULT_ACCEPT_HEADER,
    DEFAULT_ACCEPT_LANGUAGE,
    DEFAULT_USER_AGENT,
    MAX_WEB_FETCH_REDIRECTS,
    WEB_FETCH_TOOL_DESCRIPTION,
    WEB_FETCH_TOOL_INPUT_SCHEMA,
} from './constants';
import {
    createRequestSignal,
    extractHtmlContent,
    formatFetchResult,
    formatUnsupportedResponse,
    getContentType,
    isHtmlContentType,
    isTextualContentType,
    normalizeStructuredText,
    parseWebFetchRequest,
    readResponseText,
    truncateContent,
    validateWebFetchUrl,
    type WebFetchRequest,
} from './helper';
import { type ProviderFetchPayload, tryProviderFetches } from './providers';

const tauriFetch = createTauriFetch();

function formatProviderFetchResult(
    request: WebFetchRequest,
    payload: ProviderFetchPayload
): string {
    const content =
        payload.content.length > request.maxChars
            ? payload.content.slice(0, request.maxChars)
            : payload.content;
    return [
        tt('网页抓取'),
        `${tt('请求 URL')}: ${request.url.toString()}`,
        `${tt('最终 URL')}: ${payload.finalUrl ?? request.url.toString()}`,
        `${tt('内容类型')}: text/markdown`,
        `${tt('请求模式')}: ${request.mode}`,
        `${tt('实际输出')}: ${payload.provider} fetch`,
        payload.title ? `${tt('标题')}: ${payload.title}` : '',
        payload.publishedAt ? `${tt('发布时间')}: ${payload.publishedAt}` : '',
        payload.content.length > request.maxChars
            ? tt('正文输出: 已限制为 {maxChars} 字符', { maxChars: request.maxChars })
            : '',
        '',
        content || tt('[页面无可读内容]'),
    ].join('\n');
}

async function providerFetchResult(
    request: WebFetchRequest,
    signal: AbortSignal,
    mode: 'preferred' | 'fallback' | 'explicit'
): Promise<BuiltInToolExecutionResult | null> {
    try {
        const value = await readEffectiveSettingValue(SEARCH_SETTINGS_KEY);
        const settings = parseSearchSettingsConfig(typeof value === 'string' ? value : null);
        if (mode === 'explicit') {
            if (!request.provider) return null;
            const payload = await tryProviderFetches(
                request.url.toString(),
                settings,
                signal,
                request.provider
            );
            return payload
                ? {
                      result: formatProviderFetchResult(request, payload),
                      isError: false,
                      status: 'success',
                  }
                : null;
        }
        if (settings.fetchStrategy === 'direct') {
            return null;
        }
        if ((mode === 'preferred') !== (settings.fetchStrategy === 'prefer')) {
            return null;
        }
        const payload = await tryProviderFetches(request.url.toString(), settings, signal);
        return payload
            ? {
                  result: formatProviderFetchResult(request, payload),
                  isError: false,
                  status: 'success',
              }
            : null;
    } catch {
        return null;
    }
}

/** 已取消时尽早抛出，避免继续进行不可中断的同步解析。 */
function throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
        throw signal.reason instanceof Error
            ? signal.reason
            : new DOMException('WebFetch request aborted', 'AbortError');
    }
}

class WebFetchControlError extends Error {}

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function webFetchControlError(error: unknown): WebFetchControlError {
    return new WebFetchControlError(toErrorMessage(error));
}

function requestOrigin(url: URL): string {
    return `${url.protocol}//${url.host}/`;
}

function buildFetchHeaders(url: URL): Record<string, string> {
    return {
        Accept: DEFAULT_ACCEPT_HEADER,
        'Accept-Language': DEFAULT_ACCEPT_LANGUAGE,
        Referer: requestOrigin(url),
        'User-Agent': DEFAULT_USER_AGENT,
    };
}

function jinaReaderUrl(url: URL): string {
    return `https://r.jina.ai/${url.toString()}`;
}

function shouldTryReaderFallback(response: Response): boolean {
    return response.status === 403 || response.status === 429 || response.status >= 500;
}

function formatWebFetchTarget(args: Record<string, unknown>): string {
    const rawUrl = normalizeOptionalString(args.url, { collapseWhitespace: true });
    if (!rawUrl) {
        return t('builtInTools.webFetch.target');
    }

    try {
        const parsed = new URL(rawUrl);
        const path = parsed.pathname === '/' ? '' : parsed.pathname;
        const search = parsed.search || '';
        return truncateText(`${parsed.hostname}${path}${search}`, 100);
    } catch {
        return truncateText(rawUrl, 100);
    }
}

function buildWebFetchConversationSemantic(
    args: Record<string, unknown>
): BuiltInToolConversationSemantic {
    return {
        action: 'read',
        target: formatWebFetchTarget(args),
    };
}

function responseWithUrl(response: Response, url: URL): Response {
    try {
        Object.defineProperty(response, 'url', {
            value: url.toString(),
            configurable: true,
        });
    } catch {
        // Best effort only; Response.url is read-only on some implementations.
    }

    return response;
}

function isRedirectResponse(response: Response): boolean {
    return response.status >= 300 && response.status < 400;
}

function resolveRedirectUrl(location: string, baseUrl: URL): URL {
    try {
        return new URL(location, baseUrl);
    } catch {
        throw new WebFetchControlError(
            t('builtInTools.webFetch.error.invalidUrl', { url: location })
        );
    }
}

async function fetchWithSafeRedirects(
    request: WebFetchRequest,
    signal: AbortSignal
): Promise<Response> {
    let currentUrl = request.url;

    for (let redirectCount = 0; ; redirectCount += 1) {
        const init = {
            method: 'GET',
            headers: buildFetchHeaders(currentUrl),
            maxRedirections: 0,
            redirect: 'manual',
            signal,
        } satisfies RequestInit & { maxRedirections: number };
        const response = responseWithUrl(await tauriFetch(currentUrl.toString(), init), currentUrl);
        const location = response.headers.get('location');

        if (!isRedirectResponse(response) || !location) {
            return response;
        }

        if (redirectCount >= MAX_WEB_FETCH_REDIRECTS) {
            await cancelResponseBody(response, 'WebFetch redirect');
            throw new WebFetchControlError(
                t('builtInTools.webFetch.error.tooManyRedirects', {
                    maxRedirections: MAX_WEB_FETCH_REDIRECTS,
                })
            );
        }

        // Following the redirect: release the discarded redirect body before its
        // target is validated, so an invalid or disallowed Location still frees
        // the native reader instead of leaking it until GC.
        await cancelResponseBody(response, 'WebFetch redirect');

        const nextUrl = resolveRedirectUrl(location, currentUrl);
        try {
            validateWebFetchUrl(nextUrl);
        } catch (error) {
            throw webFetchControlError(error);
        }
        currentUrl = nextUrl;
    }
}

/**
 * 执行网页抓取，并把响应规范化为可继续喂给模型的文本结果。
 * @param args 工具参数。
 * @param config 当前工具配置。
 * @param context 当前执行上下文。
 * @returns 标准化后的工具执行结果。
 */
export async function executeWebFetchTool(
    args: Record<string, unknown>,
    config: Record<string, never>,
    context: BaseBuiltInToolExecutionContext
): Promise<BuiltInToolExecutionResult> {
    const request = parseWebFetchRequest(args);
    const { signal, cleanup } = createRequestSignal(context.signal, request.timeoutMs);
    void config;

    try {
        if (request.provider) {
            const explicit = await providerFetchResult(request, signal, 'explicit');
            if (explicit) {
                return explicit;
            }
        }
        const preferred = await providerFetchResult(request, signal, 'preferred');
        if (preferred) {
            return preferred;
        }
        const response = await fetchWithSafeRedirects(request, signal);
        if (shouldTryReaderFallback(response)) {
            const providerFallback = await providerFetchResult(request, signal, 'fallback');
            if (providerFallback) {
                await cancelResponseBody(response, 'WebFetch response discarded');
                return providerFallback;
            }
        }
        if (
            shouldUseJinaReaderFallback(args) &&
            !response.ok &&
            shouldTryReaderFallback(response)
        ) {
            const fallbackResult = await executeJinaReaderFallback(request, signal);
            if (fallbackResult.status === 'success') {
                await cancelResponseBody(response, 'WebFetch response discarded');
                return fallbackResult;
            }
        }
        const contentType = getContentType(response);

        if (!isTextualContentType(contentType)) {
            await cancelResponseBody(response, 'WebFetch response discarded');
            return {
                result: formatUnsupportedResponse(request, response, contentType),
                isError: true,
                status: 'error',
                errorMessage: t('builtInTools.webFetch.error.unsupportedContentType', {
                    contentType,
                }),
            };
        }

        const sourcePayload = await readResponseText(response, undefined, request.maxResponseBytes);
        const normalizedResponseText = sourcePayload.text.trim();
        const normalizedStructuredText = normalizeStructuredText(
            normalizedResponseText,
            contentType
        );
        const truncatedStructuredText = truncateContent(normalizedStructuredText, request.maxChars);

        // HTML 解析（DOMParser/Readability/Turndown）是同步且不可中断的；
        // 解析前后各检查一次取消，避免已中止/已超时的请求把结果写回 UI。
        throwIfAborted(signal);
        const payload = isHtmlContentType(contentType)
            ? {
                  ...extractHtmlContent(normalizedResponseText, request),
                  sourceTruncated: sourcePayload.sourceTruncated,
              }
            : {
                  content: truncatedStructuredText.content,
                  actualMode: request.mode,
                  bodyTruncated: truncatedStructuredText.bodyTruncated,
                  sourceTruncated: sourcePayload.sourceTruncated,
              };
        throwIfAborted(signal);

        const result = formatFetchResult(request, response, contentType, payload);
        if (!response.ok) {
            return {
                result,
                isError: true,
                status: 'error',
                errorMessage: `HTTP ${response.status} ${response.statusText}`.trim(),
            };
        }

        const resultPayload: BuiltInToolExecutionResult = {
            result,
            isError: false,
            status: 'success',
        };
        return resultPayload;
    } catch (error) {
        if (!(error instanceof WebFetchControlError)) {
            const providerFallback = await providerFetchResult(request, signal, 'fallback');
            if (providerFallback) {
                return providerFallback;
            }
        }
        if (shouldUseJinaReaderFallback(args) && !(error instanceof WebFetchControlError)) {
            const fallbackResult = await executeJinaReaderFallback(request, signal);
            if (fallbackResult.status === 'success') {
                return fallbackResult;
            }
        }

        const errorMessage = toErrorMessage(error);
        const isTimeout = error instanceof DOMException ? error.name === 'TimeoutError' : false;

        return {
            result: [
                tt('网页抓取失败'),
                `${tt('请求 URL')}: ${request.url.toString()}`,
                `${tt('原因')}: ${errorMessage}`,
            ].join('\n'),
            isError: true,
            status: isTimeout ? 'timeout' : 'error',
            errorMessage,
        };
    } finally {
        cleanup();
    }
}

function shouldUseJinaReaderFallback(args: Record<string, unknown>): boolean {
    return args.enableThirdPartyReaderFallback === true;
}

async function executeJinaReaderFallback(
    request: ReturnType<typeof parseWebFetchRequest>,
    signal: AbortSignal
): Promise<BuiltInToolExecutionResult> {
    try {
        const response = await tauriFetch(jinaReaderUrl(request.url), {
            method: 'GET',
            headers: buildFetchHeaders(request.url),
            signal,
        });
        const contentType = getContentType(response);
        if (!response.ok || !isTextualContentType(contentType)) {
            await cancelResponseBody(response, 'WebFetch response discarded');
            return {
                result: `Fallback: Jina Reader\nHTTP ${response.status} ${response.statusText}`.trim(),
                isError: true,
                status: 'error',
                errorMessage: `Jina Reader HTTP ${response.status} ${response.statusText}`.trim(),
            };
        }

        const sourcePayload = await readResponseText(response, undefined, request.maxResponseBytes);
        const normalized = normalizeStructuredText(sourcePayload.text.trim(), contentType);
        const truncated = truncateContent(normalized, request.maxChars);
        return {
            result: [
                'Fallback: Jina Reader',
                formatFetchResult(request, response, contentType, {
                    content: truncated.content,
                    actualMode: request.mode,
                    bodyTruncated: truncated.bodyTruncated,
                    sourceTruncated: sourcePayload.sourceTruncated,
                }),
            ].join('\n'),
            isError: false,
            status: 'success',
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
            result: `Fallback: Jina Reader failed\nReason: ${errorMessage}`,
            isError: true,
            status: 'error',
            errorMessage,
        };
    }
}

/**
 * WebFetch 工具。
 */
class WebFetchTool extends BuiltInTool<Record<string, never>> {
    readonly id = 'web_fetch' as const;
    readonly displayName = 'WebFetch';
    readonly description = WEB_FETCH_TOOL_DESCRIPTION;
    readonly inputSchema = WEB_FETCH_TOOL_INPUT_SCHEMA;
    readonly defaultConfig = {};

    override buildConversationSemantic(args: Record<string, unknown>) {
        return buildWebFetchConversationSemantic(args);
    }

    override execute(
        args: Record<string, unknown>,
        config: Record<string, never>,
        context: BaseBuiltInToolExecutionContext
    ) {
        return executeWebFetchTool(args, config, context);
    }
}

export const webFetchTool = new WebFetchTool();
export const builtInTools: BuiltInToolGroup = [webFetchTool];
