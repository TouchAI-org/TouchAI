// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { createTauriFetch } from '@/services/AgentService/infrastructure/providers';
import { normalizeOptionalString, truncateText } from '@/utils/text';

import {
    type BaseBuiltInToolExecutionContext,
    BuiltInTool,
    type BuiltInToolConversationSemantic,
    type BuiltInToolExecutionResult,
    type BuiltInToolGroup,
} from '../../types';
import {
    DEFAULT_ACCEPT_HEADER,
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
} from './helper';

const tauriFetch = createTauriFetch();

function formatWebFetchTarget(args: Record<string, unknown>): string {
    const rawUrl = normalizeOptionalString(args.url, { collapseWhitespace: true });
    if (!rawUrl) {
        return '网页';
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
        const response = await tauriFetch(request.url.toString(), {
            method: 'GET',
            headers: {
                Accept: DEFAULT_ACCEPT_HEADER,
            },
            signal,
        });
        const contentType = getContentType(response);

        if (!isTextualContentType(contentType)) {
            return {
                result: formatUnsupportedResponse(request, response, contentType),
                isError: true,
                status: 'error',
                errorMessage: `Unsupported content type: ${contentType}`,
            };
        }

        const sourcePayload = await readResponseText(response);
        const normalizedResponseText = sourcePayload.text.trim();
        const normalizedStructuredText = normalizeStructuredText(
            normalizedResponseText,
            contentType
        );
        const truncatedStructuredText = truncateContent(normalizedStructuredText, request.maxChars);
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

        const result = formatFetchResult(request, response, contentType, payload);
        if (!response.ok) {
            return {
                result,
                isError: true,
                status: 'error',
                errorMessage: `HTTP ${response.status} ${response.statusText}`.trim(),
            };
        }

        return {
            result,
            isError: false,
            status: 'success',
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const isTimeout = error instanceof DOMException ? error.name === 'TimeoutError' : false;

        return {
            result: [
                '网页抓取失败',
                `请求 URL: ${request.url.toString()}`,
                `原因: ${errorMessage}`,
            ].join('\n'),
            isError: true,
            status: isTimeout ? 'timeout' : 'error',
            errorMessage,
        };
    } finally {
        cleanup();
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
