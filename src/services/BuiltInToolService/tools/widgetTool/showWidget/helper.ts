// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type { ShowWidgetEventPayload, ShowWidgetMode } from '@services/AiService/types';

import type { BaseBuiltInToolExecutionContext } from '../../../types';
import { parseToolArguments } from '../../../utils/toolSchema';
import { MAX_WIDGET_HTML_CHARS, SHOW_WIDGET_TOOL_NAME, showWidgetRawArgsSchema } from './constants';

interface ShowWidgetArgs {
    iHaveSeenReadMe: boolean;
    mode: ShowWidgetMode;
    widgetId: string;
    title: string;
    description: string;
    html: string;
}

function normalizeStyleSnippet(value: string | null): string {
    return (value || '').replace(/\s+/g, ' ').trim();
}

export function readExternalResourceUrl(element: Element): string {
    return normalizeStyleSnippet(
        element.getAttribute('src') || element.getAttribute('href') || element.getAttribute('data')
    );
}

export function buildShowWidgetSummary(payload: ShowWidgetEventPayload): string {
    if (payload.mode === 'remove') {
        return [
            '自定义可视化已移除',
            `Widget ID: ${payload.widgetId}`,
            `标题: ${payload.title}`,
            `说明: ${payload.description}`,
            '完整 HTML 未写入工具结果，以免污染后续上下文。',
        ].join('\n');
    }

    return [
        '自定义可视化已渲染',
        `Widget ID: ${payload.widgetId}`,
        `标题: ${payload.title}`,
        payload.description ? `说明: ${payload.description}` : '',
        `HTML 字符数: ${payload.html.length}`,
        '接下来请继续自然解释这个可视化的重点，而不是重复输出 HTML 源码。',
    ]
        .filter(Boolean)
        .join('\n');
}

/**
 * 解析并补齐 ShowWidget 参数，统一收敛 render / remove 两种生命周期的默认值。
 *
 * @param args 工具参数。
 * @param context 当前执行上下文中和 callId 相关的最小信息。
 * @returns 标准化后的 ShowWidget 参数。
 */
export function parseShowWidgetArgs(
    args: Record<string, unknown>,
    context: Pick<BaseBuiltInToolExecutionContext, 'callId'>
): ShowWidgetArgs {
    const parsedArgs = parseToolArguments(SHOW_WIDGET_TOOL_NAME, showWidgetRawArgsSchema, args);
    const mode = parsedArgs.mode ?? 'render';
    const iHaveSeenReadMe =
        parsedArgs.i_have_seen_read_me === true || parsedArgs.iHaveSeenReadMe === true;
    const widgetId = parsedArgs.widgetId || (mode === 'render' ? context.callId : '');
    const title = parsedArgs.title || widgetId || 'ShowWidget';
    const description =
        parsedArgs.description || 'Inline generative artifact rendered in the answer.';
    const html = parsedArgs.widget_code || parsedArgs.html || '';

    if (!iHaveSeenReadMe) {
        throw new Error(
            'ShowWidget requires i_have_seen_read_me=true. Call builtin__visualize_read_me first and follow the loaded guideline before trying again.'
        );
    }

    if (!widgetId) {
        throw new Error(
            'ShowWidget requires a non-empty "widgetId" when removing an existing widget.'
        );
    }

    if (mode === 'render') {
        if (!html.trim()) {
            throw new Error(
                'ShowWidget requires a non-empty "widget_code" string when mode is "render".'
            );
        }

        if (html.length > MAX_WIDGET_HTML_CHARS) {
            throw new Error(
                `ShowWidget HTML is too large (${html.length} chars). Keep it within ${MAX_WIDGET_HTML_CHARS} chars.`
            );
        }
    }

    return {
        iHaveSeenReadMe,
        mode,
        widgetId,
        title,
        description,
        html,
    };
}
