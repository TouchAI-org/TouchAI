import { AiError, AiErrorCode } from '@/app/api/agent/errors';
import { createWidgetMarkupInspector } from '@/components/widgets/inspection';
import { t, tt } from '@/i18n';
import type { TaskViewSnapshot } from '@/modules/agent/contracts';
import { SessionTaskProjection } from '@/modules/agent/projection/create';
import { createAttachment } from '@/modules/attachments';
import {
    createAskUserTools,
    createBashTools,
    createReadTools,
    createShowWidgetTools,
    createToolPresentation,
    createWebSearchTools,
    readWebSearchConfiguration,
    SHOW_WIDGET_EXTERNAL_RESOURCE_SELECTOR,
} from '@/modules/tools';

const messages = {
    t: (key: string, values?: Record<string, string | number>) =>
        t(key as Parameters<typeof t>[0], values),
    tt,
};
export const agentPresentation = createToolPresentation(
    [
        ...createAskUserTools(messages),
        ...createBashTools({ messages }),
        ...createReadTools({ messages, attachments: { create: createAttachment } }),
        ...createShowWidgetTools({
            messages,
            markup: createWidgetMarkupInspector(SHOW_WIDGET_EXTERNAL_RESOURCE_SELECTOR),
        }),
        ...createWebSearchTools({ configuration: { read: readWebSearchConfiguration } }),
    ],
    messages
);

/** Presentation inputs match main's assembly, without a task or executable registry. */
export function createAgentProjection(snapshot: TaskViewSnapshot, publish: () => void) {
    return new SessionTaskProjection(
        snapshot,
        publish,
        {
            tt,
            errorText: (code) =>
                Object.values(AiErrorCode).includes(code as AiErrorCode)
                    ? new AiError(code as AiErrorCode).getDisplayMessage()
                    : code,
            retryText: (attempt, maxRetries) =>
                tt('重试中...({attempt}/{maxRetries})', { attempt, maxRetries }),
        },
        agentPresentation
    );
}
