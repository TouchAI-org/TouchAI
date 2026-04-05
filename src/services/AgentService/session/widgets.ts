// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { SessionMessage, WidgetInfo } from '@/types/session';

export interface WidgetTarget {
    message: SessionMessage;
    widget: WidgetInfo;
}

export interface WidgetTargetLookups {
    widgetsByCallId?: ReadonlyMap<string, WidgetTarget>;
    widgetsByWidgetId?: ReadonlyMap<string, WidgetTarget>;
}

export function ensureAssistantWidgets(message: SessionMessage): WidgetInfo[] {
    if (!message.widgets) {
        message.widgets = [];
    }

    return message.widgets;
}

export function ensureWidgetPart(message: SessionMessage, widgetId: string): void {
    const hasPart = message.parts.some(
        (part) => part.type === 'widget' && part.widgetId === widgetId
    );

    if (!hasPart) {
        message.parts.push({
            id: crypto.randomUUID(),
            type: 'widget',
            widgetId,
        });
    }
}

export function retargetWidgetPart(
    message: SessionMessage,
    previousWidgetId: string,
    nextWidgetId: string
): void {
    if (previousWidgetId === nextWidgetId) {
        return;
    }

    for (const part of message.parts) {
        if (part.type === 'widget' && part.widgetId === previousWidgetId) {
            part.widgetId = nextWidgetId;
        }
    }
}

export function findWidgetTargetByCallId(
    history: SessionMessage[],
    callId: string,
    preferredMessageId?: string,
    lookups?: WidgetTargetLookups
): WidgetTarget | null {
    const indexedTarget = lookups?.widgetsByCallId?.get(callId) ?? null;
    if (indexedTarget) {
        return indexedTarget;
    }

    return findWidgetTargetInHistory(history, preferredMessageId, (widget) => {
        return widget.callId === callId;
    });
}

export function findWidgetTarget(
    history: SessionMessage[],
    widgetId: string,
    preferredMessageId?: string,
    lookups?: WidgetTargetLookups
): WidgetTarget | null {
    const indexedTarget = lookups?.widgetsByWidgetId?.get(widgetId) ?? null;
    if (indexedTarget) {
        return indexedTarget;
    }

    return findWidgetTargetInHistory(history, preferredMessageId, (widget) => {
        return widget.widgetId === widgetId;
    });
}

function findWidgetTargetInHistory(
    history: SessionMessage[],
    preferredMessageId: string | undefined,
    matches: (widget: WidgetInfo) => boolean
): WidgetTarget | null {
    if (preferredMessageId) {
        const preferredMessage = history.find((message) => message.id === preferredMessageId);
        const preferredWidget = preferredMessage?.widgets?.find(matches);
        if (preferredMessage && preferredWidget) {
            return { message: preferredMessage, widget: preferredWidget };
        }
    }

    for (let index = history.length - 1; index >= 0; index -= 1) {
        const message = history[index];
        if (!message || message.role !== 'assistant' || message.id === preferredMessageId) {
            continue;
        }

        const widget = message.widgets?.find(matches);
        if (widget) {
            return { message, widget };
        }
    }

    return null;
}
