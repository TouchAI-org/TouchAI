import {
    finishSearch,
    mountSearchFlow,
    network,
    response,
    searchRequestFixture,
    streamingResponse,
} from '@tests/utils/searchRequest';
import { describe, expect, it } from 'vitest';

describe('given Search submits requests to the actual main Core owner', () => {
    it('user submits an unsupported attachment and keeps the draft without a model request', async () => {
        const { result, cleared } = await mountSearchFlow({
            unsupported: 'This model cannot read the attachment',
        });
        await result.handleSubmit('question');
        expect(network.requests).toEqual([]);
        expect(cleared()).toBe(0);
    });

    it('user submits with an explicit model and receives its committed conversation', async () => {
        const { result, cleared } = await mountSearchFlow({
            model: { modelId: 'fixture-model', providerId: 1 },
        });
        network.replies.push(response('Selected model answer'));
        await result.handleSubmit('question');
        expect(cleared()).toBe(1);
        expect(network.requests[0]?.model).toBe('fixture-model');
        expect(result.currentSessionId.value).toBeTruthy();
        expect(
            searchRequestFixture()
                .database.prepare(
                    "SELECT content FROM message_parts WHERE type = 'text' AND content = 'Selected model answer'"
                )
                .get()
        ).toEqual({ content: 'Selected model answer' });
    });

    it('user queues one follow-up and it starts only after the first answer commits', async () => {
        const { result, cleared } = await mountSearchFlow();
        const channel = streamingResponse();
        network.replies.push(channel.response, response('Follow-up answer'));
        const first = result.handleSubmit('first question');
        await expect.poll(() => network.requests.length).toBe(1);
        await result.handleSubmit('queued follow-up');
        await result.handleSubmit('extra prompt cannot replace queue');
        expect(result.pendingRequest.value?.query).toBe('queued follow-up');
        expect(network.requests).toHaveLength(1);
        channel.delta({ role: 'assistant', content: 'First answer' });
        channel.finish();
        await first;
        await expect.poll(() => network.requests.length).toBe(2);
        await expect.poll(() => result.isLoading.value).toBe(false);
        expect(JSON.stringify(network.requests[1]?.messages)).toContain('queued follow-up');
        expect(JSON.stringify(network.requests[1]?.messages)).not.toContain('extra prompt');
        expect(result.isWaitingForCompletion.value).toBe(false);
        expect(cleared()).toBe(2);
    });

    it('user drops the queued prompt while the current task remains active', async () => {
        const { result } = await mountSearchFlow();
        const channel = streamingResponse();
        network.replies.push(channel.response);
        const first = result.handleSubmit('keep running');
        await expect.poll(() => network.requests.length).toBe(1);
        await result.handleSubmit('discard this');
        expect(result.cancelPendingRequest()).toBe(true);
        expect(result.cancelPendingRequest()).toBe(false);
        expect(result.isLoading.value).toBe(true);
        await finishSearch(channel);
        await first;
        expect(network.requests).toHaveLength(1);
    });

    it('user cancels the active task and both the request and queued draft settle without another request', async () => {
        const { result } = await mountSearchFlow();
        const channel = streamingResponse();
        network.replies.push(channel.response);
        const first = result.handleSubmit('cancel me');
        await expect.poll(() => network.requests.length).toBe(1);
        await result.handleSubmit('queued prompt');
        result.cancelRequest();
        await first;
        expect(result.isLoading.value).toBe(false);
        expect(result.pendingRequest.value).toBeNull();
        expect(network.requests).toHaveLength(1);
        channel.delta({ role: 'assistant', content: 'late answer' });
        channel.finish();
        expect(searchRequestFixture().window.api.listActiveTasks()).toEqual([]);
    });

    it('user receives a failed request and the queued prompt cannot remain stuck or execute', async () => {
        const { result } = await mountSearchFlow();
        const reply = Promise.withResolvers<Response>();
        network.respondToGeneration = () => reply.promise;
        const first = result.handleSubmit('authentication fails');
        await expect.poll(() => network.requests.length).toBe(1);
        await result.handleSubmit('drop after failure');
        reply.resolve(new Response('{}', { status: 401 }));
        await first;
        expect(result.error.value).toBeInstanceOf(Error);
        expect(result.pendingRequest.value).toBeNull();
        expect(result.isWaitingForCompletion.value).toBe(false);
        expect(network.requests).toHaveLength(1);
    });

    it('user switches conversations while a task runs and drops the old queue without stopping that task', async () => {
        const { result, modelOverride } = await mountSearchFlow();
        const channel = streamingResponse();
        network.replies.push(channel.response);
        const first = result.handleSubmit('background conversation');
        await expect.poll(() => network.requests.length).toBe(1);
        await result.handleSubmit('old queue');
        expect(await result.openSession(7)).toMatchObject({ sessionId: 7, title: 'Alpha project' });
        expect(modelOverride.value).toEqual({ modelId: 'fixture-model', providerId: 1 });
        expect(result.pendingRequest.value).toBeNull();
        expect(result.currentSessionId.value).toBe(7);
        expect(searchRequestFixture().window.api.listActiveTasks()).toHaveLength(1);
        await finishSearch(channel);
        await first;
        expect(result.currentSessionId.value).toBe(7);
    });

    it('user clears and reopens the most recently closed conversation once', async () => {
        const { result } = await mountSearchFlow();
        expect(await result.reopenLastClosedSession()).toBeNull();
        await result.openSession(7);
        result.startNewSession();
        expect(result.currentSessionId.value).toBeNull();
        expect(await result.reopenLastClosedSession()).toMatchObject({ sessionId: 7 });
        expect(await result.reopenLastClosedSession()).toBeNull();
    });

    it('user closes a deleted conversation and a failed reopen forgets the missing identity', async () => {
        const { result } = await mountSearchFlow();
        await result.openSession(7);
        result.clearAll();
        searchRequestFixture().database.exec('DELETE FROM sessions WHERE id = 7');
        await expect(result.reopenLastClosedSession()).rejects.toThrow('Session 7 not found');
        expect(await result.reopenLastClosedSession()).toBeNull();
    });

    it('user opens the already visible conversation without clearing its draft again', async () => {
        const { result, cleared } = await mountSearchFlow();
        await result.openSession(7);
        const before = cleared();
        expect(await result.openSession(7)).toMatchObject({ sessionId: 7 });
        expect(cleared()).toBe(before);
    });

    it('user regenerates a completed reply from its nearest saved user prompt', async () => {
        const { result } = await mountSearchFlow();
        network.replies.push(response('Original answer'), response('Regenerated answer'));
        await result.handleSubmit('Original question');
        const reply = result.sessionHistory.value.find((message) => message.role === 'assistant')!;
        await result.handleRegenerateMessage(reply.id);
        expect(network.requests).toHaveLength(2);
        expect(JSON.stringify(network.requests[1]?.messages)).toContain('Original question');
        expect(
            searchRequestFixture()
                .database.prepare(
                    "SELECT count(*) AS count FROM message_parts WHERE type = 'text' AND content = 'Original question'"
                )
                .get()
        ).toEqual({ count: 2 });
    });

    it('user targets a first or missing message for regeneration and no prompt is submitted', async () => {
        const { result } = await mountSearchFlow();
        await result.openSession(7);
        await result.handleRegenerateMessage('missing');
        expect(network.requests).toEqual([]);
    });
});
