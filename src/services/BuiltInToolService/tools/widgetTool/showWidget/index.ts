// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type { ShowWidgetEventPayload } from '@services/AiService/types';

import {
    type BaseBuiltInToolExecutionContext,
    BuiltInTool,
    type BuiltInToolExecutionResult,
} from '../../../types';
import {
    FORBIDDEN_WIDGET_RULES,
    SHOW_WIDGET_EXTERNAL_RESOURCE_SELECTOR,
    SHOW_WIDGET_TOOL_DESCRIPTION,
    SHOW_WIDGET_TOOL_INPUT_SCHEMA,
} from './constants';
import { buildShowWidgetSummary, parseShowWidgetArgs, readExternalResourceUrl } from './helper';
import { isShowWidgetResourceUrlAllowed } from './runtime';
import { SHOW_WIDGET_ALLOWED_RESOURCE_HOSTS } from './runtimeConstants';

/**
 * 简化后的校验只保留“必须禁止”的硬规则。
 */
function validateShowWidgetMarkup(html: string): void {
    const violations = new Set<string>();

    for (const rule of FORBIDDEN_WIDGET_RULES) {
        if (rule.pattern.test(html)) {
            violations.add(rule.reason);
        }
    }

    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const rootElement = parsed.body.firstElementChild;
    if (!rootElement) {
        throw new Error('ShowWidget widget_code must contain a visible root element.');
    }

    const externalResourceElements = parsed.querySelectorAll<HTMLElement>(
        SHOW_WIDGET_EXTERNAL_RESOURCE_SELECTOR
    );
    for (const element of externalResourceElements) {
        const resourceUrl = readExternalResourceUrl(element);
        if (!resourceUrl || isShowWidgetResourceUrlAllowed(resourceUrl)) {
            continue;
        }

        violations.add(
            `External resources must stay within the allowlist: ${SHOW_WIDGET_ALLOWED_RESOURCE_HOSTS.join(', ')}.`
        );
    }

    if (violations.size > 0) {
        throw new Error(
            [
                'ShowWidget design validation failed. Re-read builtin__visualize_read_me and regenerate the widget_code.',
                ...[...violations].map((reason) => `- ${reason}`),
            ].join('\n')
        );
    }
}

/**
 * 执行 ShowWidget 工具，并把 render/remove 生命周期映射为统一的 widget 事件。
 * @param args 工具参数。
 * @param config 当前工具配置。
 * @param context 当前执行上下文。
 * @returns 标准化后的工具执行结果。
 */
export async function executeShowWidgetTool(
    args: Record<string, unknown>,
    config: Record<string, never>,
    context: BaseBuiltInToolExecutionContext
): Promise<BuiltInToolExecutionResult> {
    void config;
    void context.signal;

    if (!context.hasExecutedBuiltInTool('visualize_read_me')) {
        throw new Error(
            'ShowWidget guideline has not been loaded in a previous tool round yet. Call builtin__visualize_read_me first, let the model read the returned guideline, and then call builtin__show_widget in the next round.'
        );
    }

    const parsed = parseShowWidgetArgs(args, context);

    if (parsed.mode === 'render' && parsed.html.trim()) {
        validateShowWidgetMarkup(parsed.html);
    }

    const payload: ShowWidgetEventPayload = {
        callId: context.callId,
        widgetId: parsed.widgetId,
        title: parsed.title,
        description: parsed.description,
        html: parsed.html,
        mode: parsed.mode,
        phase: 'ready',
    };

    if (parsed.mode === 'remove') {
        context.emitToolEvent?.({
            type: 'widget_remove',
            callId: context.callId,
            widgetId: parsed.widgetId,
        });
    } else {
        context.emitToolEvent?.({
            type: 'widget_upsert',
            ...payload,
        });
    }

    return {
        result: buildShowWidgetSummary(payload),
        isError: false,
        status: 'success',
    };
}

/**
 * ShowWidget 工具。
 */
class ShowWidgetTool extends BuiltInTool<Record<string, never>> {
    readonly id = 'show_widget' as const;
    readonly displayName = 'ShowWidget';
    readonly description = SHOW_WIDGET_TOOL_DESCRIPTION;
    readonly inputSchema = SHOW_WIDGET_TOOL_INPUT_SCHEMA;
    readonly defaultConfig = {};

    override execute(
        args: Record<string, unknown>,
        config: Record<string, never>,
        context: BaseBuiltInToolExecutionContext
    ) {
        return executeShowWidgetTool(args, config, context);
    }
}

export const showWidgetTool = new ShowWidgetTool();
