import { createWidgetMarkupInspector } from '@/components/widgets/inspection';
import { t, tt } from '@/i18n';
import {
    createShowWidgetTools,
    createWidgetDrafts,
    SHOW_WIDGET_EXTERNAL_RESOURCE_SELECTOR,
} from '@/modules/tools';
import { buildShowWidgetSummary } from '@/modules/tools/builtin/show-widget/arguments';

export function createWidgetToolsFixture() {
    const messages = {
        t: (key: string, values?: Record<string, string | number>) =>
            t(key as Parameters<typeof t>[0], values),
        tt,
    };
    const tools = createShowWidgetTools({
        messages,
        markup: createWidgetMarkupInspector(SHOW_WIDGET_EXTERNAL_RESOURCE_SELECTOR),
    });
    return {
        tools,
        tool: tools[0]!,
        drafts: createWidgetDrafts(messages),
        summary: (payload: Parameters<typeof buildShowWidgetSummary>[0]) =>
            buildShowWidgetSummary(payload, messages),
    };
}
