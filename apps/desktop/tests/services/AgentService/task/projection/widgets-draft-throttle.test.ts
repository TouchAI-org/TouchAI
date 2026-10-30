import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AiToolCallDelta } from '@/services/AgentService/contracts/tooling';
import { ProjectionWidgets } from '@/services/AgentService/task/projection/widgets';
import type { SessionMessage } from '@/types/session';

const { buildDraftSpy } = vi.hoisted(() => ({ buildDraftSpy: vi.fn() }));

vi.mock('@/services/BuiltInToolService/tools/widgetTool', async (importOriginal) => {
    const actual =
        await importOriginal<typeof import('@/services/BuiltInToolService/tools/widgetTool')>();
    buildDraftSpy.mockImplementation(actual.buildShowWidgetDraftFromArgumentsBuffer);
    return {
        ...actual,
        buildShowWidgetDraftFromArgumentsBuffer: buildDraftSpy,
    };
});

function createHistory(): SessionMessage[] {
    return [
        {
            id: 'assistant-1',
            role: 'assistant',
            content: '',
            parts: [],
            timestamp: 1,
            isStreaming: true,
        },
    ];
}

function createDelta(callId: string, argumentsBuffer: string): AiToolCallDelta {
    return {
        index: 0,
        callId,
        name: 'builtin__show_widget',
        argumentsBuffer,
        isComplete: false,
    };
}

describe('ProjectionWidgets draft rebuild cost', () => {
    beforeEach(() => {
        buildDraftSpy.mockClear();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('does not rebuild the draft when the arguments buffer is unchanged', () => {
        const widgets = new ProjectionWidgets();
        const history = createHistory();
        const buffer = '{"widget_id":"w1","title":"Title"';

        widgets.handleToolCallDelta(history, 'assistant-1', createDelta('call-1', buffer));
        expect(buildDraftSpy).toHaveBeenCalledTimes(1);

        widgets.handleToolCallDelta(history, 'assistant-1', createDelta('call-1', buffer));
        widgets.handleToolCallDelta(history, 'assistant-1', createDelta('call-1', buffer));
        expect(buildDraftSpy).toHaveBeenCalledTimes(1);
    });

    it('throttles rapid buffer growth and rebuilds on the trailing edge', () => {
        vi.useFakeTimers();
        const widgets = new ProjectionWidgets();
        const history = createHistory();
        const prefix = '{"widget_id":"w1","html":"<div>' + 'x'.repeat(2000);

        widgets.handleToolCallDelta(history, 'assistant-1', createDelta('call-1', prefix + 'a'));
        expect(buildDraftSpy).toHaveBeenCalledTimes(1);

        // 超过节流阈值后，窗口内的后续 delta 不再重新解析整段累计 JSON。
        widgets.handleToolCallDelta(history, 'assistant-1', createDelta('call-1', prefix + 'ab'));
        widgets.handleToolCallDelta(history, 'assistant-1', createDelta('call-1', prefix + 'abc'));
        expect(buildDraftSpy).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(200);

        expect(buildDraftSpy).toHaveBeenCalledTimes(2);
        expect(buildDraftSpy).toHaveBeenLastCalledWith('call-1', prefix + 'abc');
    });

    it('rebuilds immediately for the finished tool call and clears per-call state', () => {
        vi.useFakeTimers();
        const widgets = new ProjectionWidgets();
        const history = createHistory();
        const buffer = '{"widget_id":"w1","title":"Title"';

        widgets.handleToolCallDelta(history, 'assistant-1', createDelta('call-1', buffer));
        widgets.finalizeToolCall(history, 'call-1');
        buildDraftSpy.mockClear();

        widgets.handleToolCallDelta(history, 'assistant-1', createDelta('call-1', buffer));
        expect(buildDraftSpy).toHaveBeenCalledTimes(1);
    });
});
