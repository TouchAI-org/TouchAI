// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { ProjectionWidgets } from '@services/AgentService/task/projection/widgets';
import { describe, expect, it } from 'vitest';

import type { AiToolCall, AiToolCallDelta } from '@/services/AgentService/contracts/tooling';
import type { SessionMessage, WidgetInfo } from '@/types/session';

const SHOW_WIDGET = 'builtin__show_widget';

function assistantMessage(id = 'message-1'): SessionMessage {
    return {
        id,
        role: 'assistant',
        content: '',
        parts: [],
        timestamp: 0,
    };
}

function widgetParts(message: SessionMessage): string[] {
    return message.parts
        .filter((part) => part.type === 'widget')
        .map((part) => (part.type === 'widget' ? part.widgetId : ''));
}

function streamedCall(
    argumentsBuffer: string,
    overrides: Partial<AiToolCallDelta> = {}
): AiToolCallDelta {
    return {
        index: 0,
        callId: 'call-1',
        name: SHOW_WIDGET,
        argumentsBuffer,
        ...overrides,
    };
}

function finishedCall(argumentsObject: Record<string, unknown>, id = 'call-1'): AiToolCall {
    return { id, name: SHOW_WIDGET, arguments: JSON.stringify(argumentsObject) };
}

function widgetOf(message: SessionMessage, widgetId: string): WidgetInfo | undefined {
    return message.widgets?.find((widget) => widget.widgetId === widgetId);
}

describe('user watches a widget being generated in the reply', () => {
    it('user sees a draft widget appear while the widget arguments are still streaming', () => {
        const projection = new ProjectionWidgets();
        const message = assistantMessage();

        projection.handleToolCallDelta(
            [message],
            message.id,
            streamedCall('{"widgetId": "w1", "ti')
        );

        expect(message.widgets).toHaveLength(1);
        expect(message.widgets?.[0]).toMatchObject({
            callId: 'call-1',
            widgetId: 'w1',
            phase: 'draft',
        });
        expect(widgetParts(message)).toEqual(['w1']);
    });

    it('user sees the draft filled in as more of the widget arguments arrive', () => {
        const projection = new ProjectionWidgets();
        const message = assistantMessage();

        projection.handleToolCallDelta(
            [message],
            message.id,
            streamedCall('{"widgetId": "w1", "title": "销售概览", "widget_code": "<div>1</div>')
        );
        projection.handleToolCallDelta(
            [message],
            message.id,
            streamedCall(
                '{"widgetId": "w1", "title": "销售概览", "widget_code": "<div>1</div><p>done</p>"}'
            )
        );

        expect(message.widgets).toHaveLength(1);
        expect(message.widgets?.[0]).toMatchObject({
            widgetId: 'w1',
            title: '销售概览',
            html: '<div>1</div><p>done</p>',
        });
        // The rendered part is not duplicated on every delta.
        expect(widgetParts(message)).toEqual(['w1']);
    });

    it('user does not see a widget when a different tool streams its arguments', () => {
        const projection = new ProjectionWidgets();
        const message = assistantMessage();

        projection.handleToolCallDelta(
            [message],
            message.id,
            streamedCall('{"command": "dir"}', { name: 'builtin__bash' })
        );

        expect(message.widgets ?? []).toHaveLength(0);
        expect(message.parts).toHaveLength(0);
    });

    it('user sees the finished widget with its parsed title, description, and markup', () => {
        const projection = new ProjectionWidgets();
        const message = assistantMessage();

        projection.processFinishedToolCall(
            [message],
            message.id,
            finishedCall({
                widgetId: 'w1',
                title: '销售概览',
                description: '按区域拆分',
                widget_code: '<div>chart</div>',
            })
        );

        expect(widgetOf(message, 'w1')).toMatchObject({
            callId: 'call-1',
            title: '销售概览',
            description: '按区域拆分',
            html: '<div>chart</div>',
            mode: 'render',
            phase: 'draft',
        });
        expect(widgetParts(message)).toEqual(['w1']);
    });

    it('user sees the call id stand in as the widget title when the model names neither', () => {
        const projection = new ProjectionWidgets();
        const message = assistantMessage();

        projection.processFinishedToolCall(
            [message],
            message.id,
            finishedCall({ widget_code: '<div>chart</div>' })
        );

        expect(message.widgets?.[0]).toMatchObject({
            widgetId: 'call-1',
            title: 'call-1',
            html: '<div>chart</div>',
        });
    });

    it('user does not get a widget from a finished call that is not the widget tool', () => {
        const projection = new ProjectionWidgets();
        const message = assistantMessage();

        projection.processFinishedToolCall([message], message.id, {
            id: 'call-1',
            name: 'builtin__bash',
            arguments: '{"command": "dir"}',
        });

        expect(message.widgets ?? []).toHaveLength(0);
    });

    it('user keeps the same widget when the generated id changes mid-stream', () => {
        const projection = new ProjectionWidgets();
        const message = assistantMessage();

        projection.handleToolCallDelta(
            [message],
            message.id,
            streamedCall('{"widgetId": "draft-id", "title": "A"}')
        );
        projection.handleToolCallDelta(
            [message],
            message.id,
            streamedCall('{"widgetId": "final-id", "title": "A"}')
        );

        expect(message.widgets).toHaveLength(1);
        expect(message.widgets?.[0]?.widgetId).toBe('final-id');
        expect(widgetParts(message)).toEqual(['final-id']);
    });

    it('user sees the widget removed from the reply when the model deletes it', () => {
        const projection = new ProjectionWidgets();
        const message = assistantMessage();

        projection.processFinishedToolCall(
            [message],
            message.id,
            finishedCall({ widgetId: 'w1', title: 'A', widget_code: '<div>1</div>' })
        );
        projection.removeWidgetByWidgetId([message], 'w1', message.id);

        expect(message.widgets ?? []).toHaveLength(0);
        expect(widgetParts(message)).toEqual([]);
    });

    it('user keeps the finished widget when a later failed draft is discarded', () => {
        const projection = new ProjectionWidgets();
        const message = assistantMessage();

        projection.processFinishedToolCall(
            [message],
            message.id,
            finishedCall({ widgetId: 'ready-1', title: 'ready', widget_code: '<div>1</div>' })
        );
        message.widgets![0]!.phase = 'ready';

        projection.handleToolCallDelta(
            [message],
            message.id,
            streamedCall('{"widgetId": "draft-1", "widget_code": "<div>2</div>"}', {
                callId: 'call-2',
            })
        );
        projection.finalizeToolCall([message], 'call-2', { removeDraft: true });

        expect(message.widgets?.map((widget) => widget.widgetId)).toEqual(['ready-1']);
        expect(widgetParts(message)).toEqual(['ready-1']);
    });

    it('user sees the widget tool call kept out of the visible tool list', () => {
        const projection = new ProjectionWidgets();

        expect(projection.isHiddenBuiltinToolCall(SHOW_WIDGET)).toBe(true);
        expect(projection.isHiddenBuiltinToolCall('builtin__bash')).toBe(false);
    });
});
