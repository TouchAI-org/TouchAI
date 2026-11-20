import { normalizeOptionalString, truncateText } from '@/utils/text';

import {
    type BaseBuiltInToolExecutionContext,
    BuiltInTool,
    type BuiltInToolExecutionResult,
    type BuiltInToolGroup,
} from '../../contracts/builtin';
import type { ShowWidgetEventPayload } from '../../contracts/events';
import type { ToolMessages } from '../../contracts/host';
import { buildShowWidgetSummary, parseShowWidgetArgs } from './arguments';
import {
    FORBIDDEN_WIDGET_RULES,
    SHOW_WIDGET_TOOL_DESCRIPTION,
    SHOW_WIDGET_TOOL_INPUT_SCHEMA,
} from './constants';
import {
    isShowWidgetResourceUrlAllowed,
    SHOW_WIDGET_ALLOWED_RESOURCE_HOSTS,
    type WidgetMarkupInspector,
} from './policy';

const NON_VISIBLE_ROOT_TAG_NAMES = new Set(['LINK', 'META', 'SCRIPT', 'STYLE', 'TITLE']);

export function createShowWidgetTools(options: {
    messages: ToolMessages;
    markup: WidgetMarkupInspector;
}): BuiltInToolGroup {
    const messages = Object.freeze({
        t: options.messages.t.bind(options.messages),
        tt: options.messages.tt.bind(options.messages),
    });
    const inspect = options.markup.inspect.bind(options.markup);

    function validate(html: string): void {
        const markup = inspect(html);
        if (!markup.firstElementTag)
            throw new Error('ShowWidget widget_code must contain a visible root element.');
        if (NON_VISIBLE_ROOT_TAG_NAMES.has(markup.firstElementTag.toUpperCase())) {
            throw new Error(
                'ShowWidget widget_code must start with a visible root element before style or script blocks.'
            );
        }
        const violations = new Set<string>();
        for (const rule of FORBIDDEN_WIDGET_RULES)
            if (rule.pattern.test(html)) violations.add(rule.reason);
        for (const url of markup.resourceUrls)
            if (!isShowWidgetResourceUrlAllowed(url, markup.baseUrl)) {
                violations.add(
                    `External resources must stay within the allowlist: ${SHOW_WIDGET_ALLOWED_RESOURCE_HOSTS.join(', ')}.`
                );
            }
        if (violations.size)
            throw new Error(
                [
                    'ShowWidget design validation failed. Review the built-in widget skill and regenerate the widget_code.',
                    ...[...violations].map((reason) => `- ${reason}`),
                ].join('\n')
            );
    }

    class ShowWidgetTool extends BuiltInTool<Record<string, never>> {
        readonly id = 'show_widget' as const;
        readonly displayName = 'ShowWidget';
        readonly description = SHOW_WIDGET_TOOL_DESCRIPTION;
        readonly inputSchema = SHOW_WIDGET_TOOL_INPUT_SCHEMA;
        readonly defaultConfig = {};

        override buildConversationSemantic(args: Record<string, unknown>) {
            return {
                action: args.mode === 'remove' ? ('remove' as const) : ('render' as const),
                target: truncateText(
                    normalizeOptionalString(args.title, { collapseWhitespace: true }) ||
                        normalizeOptionalString(args.widgetId, { collapseWhitespace: true }) ||
                        messages.tt('可视化'),
                    80
                ),
            };
        }

        override async execute(
            args: Record<string, unknown>,
            _config: Record<string, never>,
            context: BaseBuiltInToolExecutionContext
        ): Promise<BuiltInToolExecutionResult> {
            if (context.signal?.aborted) throw new Error('REQUEST_CANCELLED');
            const parsed = parseShowWidgetArgs(args, context);
            if (parsed.mode === 'render') validate(parsed.html);
            if (context.signal?.aborted) throw new Error('REQUEST_CANCELLED');
            const payload: ShowWidgetEventPayload = {
                callId: context.callId,
                ...parsed,
                phase: 'ready',
            };
            if (parsed.mode === 'remove')
                context.emitToolEvent?.({
                    type: 'widget_remove',
                    callId: context.callId,
                    widgetId: parsed.widgetId,
                });
            else context.emitToolEvent?.({ type: 'widget_upsert', ...payload });
            return {
                result: buildShowWidgetSummary(payload, messages),
                isError: false,
                status: 'success',
            };
        }
    }
    return [new ShowWidgetTool()];
}
