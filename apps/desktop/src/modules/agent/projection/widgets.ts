// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * Widget 生命周期投影。
 *
 * 持有 `show_widget` 流式草稿检测所需的内部状态，
 * 负责会话消息中 `WidgetInfo` 的创建、更新、匹配与删除。
 */

import type { SessionMessage, WidgetInfo } from '../contracts/history';
import type { WidgetPayload } from '../contracts/presentation';
import {
    ensureAssistantWidgets,
    ensureWidgetPart,
    findWidgetTarget,
    findWidgetTargetByCallId,
    retargetWidgetPart,
} from '../history/widgets';

// ────────────────────── ProjectionWidgets ──────────────────────

/** Widget state is a projection; validation, argument parsing and pacing belong to tools. */
export class ProjectionWidgets {
    constructor(private readonly widgetToolName: string) {}

    isHiddenBuiltinToolCall(name?: string): boolean {
        return name === this.widgetToolName;
    }

    upsertWidget(
        history: SessionMessage[],
        messageId: string,
        payload: WidgetPayload
    ): WidgetInfo | null {
        const targetMessage =
            findWidgetTarget(history, payload.widgetId, messageId)?.message ??
            findWidgetTargetByCallId(history, payload.callId, messageId)?.message ??
            history.find((message) => message.id === messageId);
        if (!targetMessage) {
            return null;
        }

        const widgets = ensureAssistantWidgets(targetMessage);
        const existingWidget =
            widgets.find((widget) => widget.widgetId === payload.widgetId) ??
            widgets.find((widget) => widget.callId === payload.callId);

        if (existingWidget) {
            const previousWidgetId = existingWidget.widgetId;
            Object.assign(existingWidget, payload, {
                id: payload.widgetId,
                updatedAt: Date.now(),
            });
            retargetWidgetPart(targetMessage, previousWidgetId, payload.widgetId);
            ensureWidgetPart(targetMessage, payload.widgetId);
            return existingWidget;
        }

        const widget: WidgetInfo = {
            id: payload.widgetId,
            ...payload,
            updatedAt: Date.now(),
        };
        widgets.push(widget);
        ensureWidgetPart(targetMessage, payload.widgetId);
        return widget;
    }

    removeWidgetByWidgetId(
        history: SessionMessage[],
        widgetId: string,
        preferredMessageId?: string
    ): void {
        const target = findWidgetTarget(history, widgetId, preferredMessageId);
        if (!target) {
            return;
        }

        target.message.widgets = target.message.widgets?.filter(
            (widget) => widget.widgetId !== widgetId
        );
        target.message.parts = target.message.parts.filter(
            (part) => !(part.type === 'widget' && part.widgetId === widgetId)
        );
    }

    removeWidgetByCallId(
        history: SessionMessage[],
        callId: string,
        options: { draftOnly?: boolean } = {}
    ): void {
        for (const message of history) {
            if (message.role !== 'assistant' || !message.widgets?.length) {
                continue;
            }

            const removedWidgetIds = message.widgets
                .filter((widget) => {
                    if (widget.callId !== callId) {
                        return false;
                    }

                    if (!options.draftOnly) {
                        return true;
                    }

                    return widget.phase === 'draft';
                })
                .map((widget) => widget.widgetId);

            if (removedWidgetIds.length === 0) {
                continue;
            }

            message.widgets = message.widgets.filter(
                (widget) => !removedWidgetIds.includes(widget.widgetId)
            );
            message.parts = message.parts.filter(
                (part) => !(part.type === 'widget' && removedWidgetIds.includes(part.widgetId))
            );
        }
    }

    finalizeToolCall(
        history: SessionMessage[],
        callId: string,
        options: { removeDraft?: boolean } = {}
    ): void {
        if (options.removeDraft) this.removeWidgetByCallId(history, callId, { draftOnly: true });
    }
}
