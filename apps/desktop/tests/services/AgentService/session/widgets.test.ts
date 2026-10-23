// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import {
    ensureAssistantWidgets,
    ensureWidgetPart,
    findWidgetTarget,
    findWidgetTargetByCallId,
    retargetWidgetPart,
} from '@services/AgentService/session/widgets';
import { describe, expect, it } from 'vitest';

import type { SessionMessage, WidgetInfo } from '@/types/session';

function widget(widgetId: string, callId = `call-${widgetId}`): WidgetInfo {
    return {
        id: widgetId,
        widgetId,
        callId,
        title: widgetId,
        description: '',
        html: '',
        mode: 'render',
        phase: 'ready',
        updatedAt: 0,
    };
}

function message(id: string, role: 'user' | 'assistant', widgets?: WidgetInfo[]): SessionMessage {
    return {
        id,
        role,
        content: '',
        parts: [],
        timestamp: 0,
        ...(widgets ? { widgets } : {}),
    };
}

function widgetIds(message: SessionMessage): string[] {
    return message.parts
        .filter((part) => part.type === 'widget')
        .map((part) => (part.type === 'widget' ? part.widgetId : ''));
}

describe('user reopens a conversation that contains widgets', () => {
    it('user sees the widget list created for an assistant reply that has none yet', () => {
        const target = message('m1', 'assistant');

        const widgets = ensureAssistantWidgets(target);

        expect(widgets).toEqual([]);
        expect(target.widgets).toBe(widgets);
    });

    it('user does not get a duplicate widget placeholder when the reply already shows the widget', () => {
        const target = message('m1', 'assistant', [widget('w1')]);

        ensureWidgetPart(target, 'w1');
        ensureWidgetPart(target, 'w1');
        ensureWidgetPart(target, 'w2');

        expect(widgetIds(target)).toEqual(['w1', 'w2']);
    });

    it('user sees the widget placeholder follow the widget when the model renames it', () => {
        const target = message('m1', 'assistant', [widget('draft-id')]);
        ensureWidgetPart(target, 'draft-id');

        retargetWidgetPart(target, 'draft-id', 'final-id');

        expect(widgetIds(target)).toEqual(['final-id']);
    });

    it('user sees the newest assistant reply found by widget id', () => {
        const older = message('m1', 'assistant', [widget('w1')]);
        const newer = message('m2', 'assistant', [widget('w1')]);
        const history = [older, newer];

        expect(findWidgetTarget(history, 'w1')).toEqual({ message: newer, widget: widget('w1') });
    });

    it('user sees the reply the widget was last updated from preferred over the newest one', () => {
        const older = message('m1', 'assistant', [widget('w1')]);
        const newer = message('m2', 'assistant', [widget('w1')]);

        expect(findWidgetTarget([older, newer], 'w1', 'm1')).toEqual({
            message: older,
            widget: widget('w1'),
        });
    });

    it('user does not see a widget found in a user message', () => {
        const userTurn = message('m1', 'user', [widget('w1')]);

        expect(findWidgetTarget([userTurn], 'w1')).toBeNull();
    });

    it('user sees the widget found by the tool call that produced it', () => {
        const target = message('m1', 'assistant', [widget('w1', 'call-7')]);

        expect(findWidgetTargetByCallId([target], 'call-7')).toEqual({
            message: target,
            widget: widget('w1', 'call-7'),
        });
        expect(findWidgetTargetByCallId([target], 'call-8')).toBeNull();
    });

    it('user sees the indexed widget used instead of scanning the conversation', () => {
        const indexed = message('indexed', 'assistant', [widget('w1')]);
        const scanned = message('scanned', 'assistant', [widget('w1')]);

        expect(
            findWidgetTarget([scanned], 'w1', undefined, {
                widgetsByWidgetId: new Map([['w1', { message: indexed, widget: widget('w1') }]]),
            })
        ).toEqual({ message: indexed, widget: widget('w1') });
        expect(
            findWidgetTargetByCallId([scanned], 'call-w1', undefined, {
                widgetsByCallId: new Map([['call-w1', { message: indexed, widget: widget('w1') }]]),
            })
        ).toEqual({ message: indexed, widget: widget('w1') });
    });
});
