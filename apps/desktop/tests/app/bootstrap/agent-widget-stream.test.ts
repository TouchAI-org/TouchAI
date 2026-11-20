import {
    createAgentWindowFixture,
    network,
    response,
    streamingResponse,
} from '@tests/utils/agentWindow';
import { describe, expect, it, vi } from 'vitest';

import type { TaskViewSnapshot } from '@/app/api/agent/contracts';
import { SHOW_WIDGET_DRAFT_MIN_INTERVAL_MS } from '@/modules/tools';

const firstHtml = '<div>' + 'x'.repeat(2100);
const widget = (snapshot: TaskViewSnapshot | null) =>
    snapshot?.sessionHistory.flatMap((message) => message.widgets ?? [])[0];

async function fixture() {
    const input = createAgentWindowFixture();
    await input.window.ready;
    await input.window.capabilities.waitForAgent();
    await input.window.settings.initialize();
    const channel = streamingResponse();
    network.replies.push(channel.response);
    vi.useFakeTimers();
    const started = await input.window.api.startTask({ prompt: 'Show a widget' });
    await vi.waitFor(() => expect(network.requests).toHaveLength(1));
    const prefix = `{"is_read_widget_skill":true,"widgetId":"widget-1","widget_code":${JSON.stringify(firstHtml).slice(0, -1)}`;
    const send = (argumentsDelta: string, initial = false) =>
        channel.delta({
            tool_calls: [
                {
                    index: 0,
                    ...(initial ? { id: 'widget-call', type: 'function' } : {}),
                    function: {
                        ...(initial ? { name: 'builtin__show_widget' } : {}),
                        arguments: argumentsDelta,
                    },
                },
            ],
        });
    send(prefix, true);
    await vi.waitFor(() =>
        expect(widget(input.window.api.getTaskSnapshot(started.taskId))?.html).toBe(firstHtml)
    );
    return {
        ...input,
        channel,
        started,
        send,
        async dispose() {
            channel.fail(new DOMException('fixture stream closed', 'AbortError'));
            await input.window.dispose();
            vi.restoreAllMocks();
        },
    };
}

describe('given a validated Widget draft streams through the real production host', () => {
    it('user receives the newest paused draft after the existing pacing interval without another model chunk', async () => {
        const input = await fixture();
        try {
            input.send(' next');
            input.send(' latest');
            await vi.advanceTimersByTimeAsync(0);
            expect(widget(input.window.api.getTaskSnapshot(input.started.taskId))?.html).toBe(
                firstHtml
            );
            await vi.advanceTimersByTimeAsync(SHOW_WIDGET_DRAFT_MIN_INTERVAL_MS);
            expect(widget(input.window.api.getTaskSnapshot(input.started.taskId))?.html).toBe(
                firstHtml + ' next latest'
            );
            expect(network.requests).toHaveLength(1);
        } finally {
            await input.dispose();
        }
    });

    it('user receives final arguments immediately and no pending timer can overwrite the finished widget', async () => {
        const input = await fixture();
        try {
            input.send(' pending');
            await vi.advanceTimersByTimeAsync(0);
            input.send(' final</div>"}');
            input.channel.finish('tool_calls');
            network.replies.push(response('Widget finished'));
            await vi.advanceTimersByTimeAsync(0);
            expect((await input.started.completion).response).toBe('Widget finished');
            expect(widget(input.window.api.getTaskSnapshot(input.started.taskId))).toMatchObject({
                html: firstHtml + ' pending final</div>',
                phase: 'ready',
                widgetId: 'widget-1',
            });
            const completed = input.window.api.getTaskSnapshot(input.started.taskId)!;
            await vi.advanceTimersByTimeAsync(SHOW_WIDGET_DRAFT_MIN_INTERVAL_MS);
            expect(input.window.api.getTaskSnapshot(input.started.taskId)).toEqual(completed);
        } finally {
            await input.dispose();
        }
    });

    it('user cancels with a pending draft and receives no late update into the terminal or following task', async () => {
        const input = await fixture();
        try {
            input.send(' pending');
            await vi.advanceTimersByTimeAsync(0);
            const failed = expect(input.started.completion).rejects.toMatchObject({
                code: 'REQUEST_CANCELLED',
            });
            input.window.api.cancelTask(input.started.taskId);
            await failed;
            const cancelled = input.window.api.getTaskSnapshot(input.started.taskId)!;
            network.replies.push(response('Following request'));
            const following = await input.window.api.startTask({
                prompt: 'Continue without the widget draft',
                sessionId: cancelled.sessionId!,
            });
            expect((await following.completion).response).toBe('Following request');
            await vi.advanceTimersByTimeAsync(SHOW_WIDGET_DRAFT_MIN_INTERVAL_MS);
            expect(input.window.api.getTaskSnapshot(input.started.taskId)).toEqual(cancelled);
            expect(widget(input.window.api.getTaskSnapshot(following.taskId))).toBeUndefined();
        } finally {
            await input.dispose();
        }
    });
});
