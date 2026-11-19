import {
    createAgentWindowFixture,
    network,
    response,
    streamingResponse,
} from '@tests/utils/agentWindow';
import { mountComposable } from '@tests/utils/composables';
import { afterEach, describe, expect, it } from 'vitest';

import { agentApiKey } from '@/app/api/agent';
import { useAgent } from '@/composables/agent/useAgent';

let fixture: ReturnType<typeof createAgentWindowFixture> | undefined;
let mounted: Awaited<ReturnType<typeof mountQueue>> | undefined;

async function mountQueue() {
    fixture = createAgentWindowFixture();
    return mountComposable(
        () => useAgent(),
        (app) => app.provide(agentApiKey, fixture!.window.api)
    );
}

afterEach(async () => {
    mounted?.unmount();
    mounted = undefined;
    await fixture?.window.dispose();
    fixture = undefined;
});

describe('given queued messages belong to the injected main agent', () => {
    it('user edits and reorders queued messages and receives the edited replies in that order', async () => {
        mounted = await mountQueue();
        const agent = mounted.result;
        const channel = streamingResponse();
        network.replies.push(
            channel.response,
            response('Second answer'),
            response('Edited answer')
        );
        const sending = agent.sendRequest('Initial prompt');
        await expect.poll(() => network.requests.length).toBe(1);
        const first = agent.enqueueUserMessage({ prompt: 'First queued' }, 'queue')!;
        const second = agent.enqueueUserMessage({ prompt: 'Second queued' }, 'queue')!;
        expect(agent.beginPendingMessageEdit(first.id)).toBe(true);
        expect(agent.updatePendingUserMessage(first.id, { prompt: 'Edited first queued' })).toBe(
            true
        );
        expect(agent.endPendingMessageEdit(first.id)).toBe(true);
        expect(agent.reorderPendingUserMessages([second.id, first.id])).toBe(true);
        expect(agent.updatePendingUserMessagesModel('fixture-model', 1)).toBe(true);
        await expect
            .poll(() => agent.pendingUserMessages.value.map((message) => message.prompt))
            .toEqual(['Second queued', 'Edited first queued']);
        expect(agent.pendingUserMessages.value).toEqual([
            expect.objectContaining({ id: second.id, modelId: 'fixture-model', providerId: 1 }),
            expect.objectContaining({ id: first.id, modelId: 'fixture-model', providerId: 1 }),
        ]);
        channel.delta({ role: 'assistant', content: 'Initial answer' });
        channel.finish();
        await sending;
        await expect.poll(() => network.requests.length).toBe(3);
        await expect.poll(() => fixture!.window.api.listActiveTasks().length).toBe(0);
        expect(JSON.stringify(network.requests[1]?.messages)).toContain('Second queued');
        expect(JSON.stringify(network.requests[1]?.messages)).not.toContain('Edited first queued');
        expect(JSON.stringify(network.requests[2]?.messages)).toContain('Edited first queued');
        await expect
            .poll(() =>
                agent.sessionHistory.value
                    .filter((message) => message.role === 'user')
                    .map((message) => message.content)
            )
            .toEqual(['Initial prompt', 'Second queued', 'Edited first queued']);
        expect(agent.pendingUserMessages.value).toEqual([]);
    });

    it('user promotes a queued message and removes another without interrupting the current reply', async () => {
        mounted = await mountQueue();
        const agent = mounted.result;
        const channel = streamingResponse();
        network.replies.push(channel.response);
        const sending = agent.sendRequest('Initial prompt');
        await expect.poll(() => network.requests.length).toBe(1);
        const first = agent.enqueueUserMessage({ prompt: 'Promote me' }, 'queue')!;
        const second = agent.enqueueUserMessage({ prompt: 'Remove me' }, 'queue')!;
        expect(agent.promotePendingUserMessage(first.id)).toBe(true);
        expect(agent.removePendingUserMessage(second.id)).toBe(true);
        await expect
            .poll(() => agent.pendingUserMessages.value)
            .toMatchObject([{ id: first.id, prompt: 'Promote me', delivery: 'priority' }]);
        expect(agent.isLoading.value).toBe(true);
        expect(agent.clearPendingUserMessages()).toBe(true);
        await expect.poll(() => agent.pendingUserMessages.value).toEqual([]);
        channel.delta({ role: 'assistant', content: 'Still responding' });
        channel.finish();
        await sending;
        expect(network.requests).toHaveLength(1);
        expect(agent.response.value).toBe('Still responding');
    });

    it('user cancels while editing a queued prompt and reopening keeps it held until the edit is released', async () => {
        mounted = await mountQueue();
        const agent = mounted.result;
        const channel = streamingResponse();
        network.replies.push(channel.response);
        const sending = agent.sendRequest('Initial prompt');
        await expect.poll(() => network.requests.length).toBe(1);
        const pending = agent.enqueueUserMessage({ prompt: 'Continue later' }, 'queue')!;
        expect(agent.beginPendingMessageEdit(pending.id)).toBe(true);
        agent.cancel();
        await sending;
        expect(
            agent.updatePendingUserMessage(pending.id, { prompt: 'Edited after cancellation' })
        ).toBe(true);
        const sessionId = agent.currentSessionId.value!;
        agent.clearSession();
        network.replies.push(response('Resumed answer'));
        await agent.openSession(sessionId);
        expect(network.requests).toHaveLength(1);
        expect(agent.endPendingMessageEdit(pending.id)).toBe(true);
        await expect.poll(() => network.requests.length).toBe(2);
        await expect.poll(() => fixture!.window.api.listActiveTasks().length).toBe(0);
        expect(JSON.stringify(network.requests[1]?.messages)).toContain(
            'Edited after cancellation'
        );
        await expect.poll(() => agent.response.value).toBe('Resumed answer');
        expect(agent.currentSessionId.value).toBe(sessionId);
        expect(agent.pendingUserMessages.value).toEqual([]);
        channel.finish();
    });

    it('user leaves a queued edit and releasing it clears the original message hold', async () => {
        mounted = await mountQueue();
        const agent = mounted.result;
        const channel = streamingResponse();
        network.replies.push(channel.response, response('Released answer'));
        const sending = agent.sendRequest('Initial prompt');
        await expect.poll(() => network.requests.length).toBe(1);
        const pending = agent.enqueueUserMessage({ prompt: 'Held for editing' }, 'queue')!;
        expect(agent.beginPendingMessageEdit(pending.id)).toBe(true);
        const sessionId = agent.currentSessionId.value!;
        agent.clearSession();
        expect(agent.endPendingMessageEdit(pending.id)).toBe(true);
        channel.delta({ role: 'assistant', content: 'Initial answer' });
        channel.finish();
        await sending;
        await expect.poll(() => network.requests.length).toBe(2);
        await expect.poll(() => fixture!.window.api.listActiveTasks().length).toBe(0);
        expect(agent.currentSessionId.value).toBeNull();
        expect(agent.sessionHistory.value).toEqual([]);
        const loaded = await fixture!.window.api.loadSession(sessionId);
        expect(loaded.history.some((message) => message.content === 'Released answer')).toBe(true);
    });

    it('user attempts queue commands without an open conversation and receives no phantom message', async () => {
        mounted = await mountQueue();
        const agent = mounted.result;
        expect(agent.enqueueUserMessage({ prompt: 'orphan' }, 'queue')).toBeNull();
        expect(agent.removePendingUserMessage('missing')).toBe(false);
        expect(agent.updatePendingUserMessage('missing', { prompt: 'edited' })).toBe(false);
        expect(agent.promotePendingUserMessage('missing')).toBe(false);
        expect(agent.beginPendingMessageEdit('missing')).toBe(false);
        expect(agent.endPendingMessageEdit('missing')).toBe(false);
        expect(agent.reorderPendingUserMessages(['missing'])).toBe(false);
        expect(agent.clearPendingUserMessages()).toBe(false);
        expect(agent.updatePendingUserMessagesModel('other-model', 1)).toBe(false);
        expect(agent.pendingUserMessages.value).toEqual([]);
        expect(network.requests).toEqual([]);
    });
});
