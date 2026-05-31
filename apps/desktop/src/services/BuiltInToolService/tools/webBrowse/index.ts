// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { t } from '@/i18n';
import { native } from '@/services/NativeService';
import { normalizeOptionalString, truncateText } from '@/utils/text';

import {
    type BaseBuiltInToolExecutionContext,
    BuiltInTool,
    type BuiltInToolConversationSemantic,
    type BuiltInToolExecutionResult,
    type BuiltInToolGroup,
} from '../../types';
import {
    WEB_BROWSE_TOOL_DESCRIPTION,
    WEB_BROWSE_TOOL_INPUT_SCHEMA,
} from './constants';
import {
    type WebBrowseNativeResponse,
    formatBrowseError,
    formatBrowseResult,
    parseWebBrowseRequest,
    toNativeRequest,
} from './helper';

function formatWebBrowseTarget(args: Record<string, unknown>): string {
    const command = normalizeOptionalString(args.command);
    if (command === 'open') {
        const rawUrl = normalizeOptionalString(args.url, { collapseWhitespace: true });
        if (rawUrl) {
            try {
                const parsed = new URL(rawUrl);
                const path = parsed.pathname === '/' ? '' : parsed.pathname;
                const search = parsed.search || '';
                return truncateText(`${parsed.hostname}${path}${search}`, 100);
            } catch {
                return truncateText(rawUrl, 100);
            }
        }
    }

    if (command === 'click' || command === 'find') {
        const selector = normalizeOptionalString(args.selector);
        if (selector) {
            return truncateText(`${command}: ${selector}`, 100);
        }
    }

    return t('builtInTools.webBrowse.target');
}

function buildWebBrowseConversationSemantic(
    args: Record<string, unknown>
): BuiltInToolConversationSemantic {
    return {
        action: 'process',
        target: formatWebBrowseTarget(args),
    };
}

/**
 * 执行 WebView 浏览命令，将请求转发到 Rust 侧 WebViewSessionManager。
 */
export async function executeWebBrowseTool(
    args: Record<string, unknown>,
    config: Record<string, never>,
    _context: BaseBuiltInToolExecutionContext
): Promise<BuiltInToolExecutionResult> {
    void config;

    const parsed = parseWebBrowseRequest(args);
    const nativeRequest = toNativeRequest(parsed);

    try {
        const response: WebBrowseNativeResponse = await native.builtInTools.webBrowse(nativeRequest);
        const result = formatBrowseResult(parsed.command, parsed, response);

        return {
            result,
            isError: false,
            status: 'success',
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        return {
            result: formatBrowseError(parsed.command, parsed, errorMessage),
            isError: true,
            status: 'error',
            errorMessage,
        };
    }
}

/**
 * WebBrowse 工具。
 */
class WebBrowseTool extends BuiltInTool<Record<string, never>> {
    readonly id = 'web_browse' as const;
    readonly displayName = 'WebBrowse';
    readonly description = WEB_BROWSE_TOOL_DESCRIPTION;
    readonly inputSchema = WEB_BROWSE_TOOL_INPUT_SCHEMA;
    readonly defaultConfig = {};

    override buildConversationSemantic(args: Record<string, unknown>) {
        return buildWebBrowseConversationSemantic(args);
    }

    override execute(
        args: Record<string, unknown>,
        config: Record<string, never>,
        context: BaseBuiltInToolExecutionContext
    ) {
        return executeWebBrowseTool(args, config, context);
    }
}

export const webBrowseTool = new WebBrowseTool();
export const builtInTools: BuiltInToolGroup = [webBrowseTool];
