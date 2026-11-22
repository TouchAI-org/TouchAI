import { mountComposable } from '@tests/utils/composables';
import {
    finishSearch,
    mountSearchFlow,
    network,
    response,
    searchRequestFixture,
    streamingResponse,
} from '@tests/utils/searchRequest';
import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

import { agentApiKey } from '@/app/api/agent';
import { createInputHistorySnapshot } from '@/app/api/agent/history';
import { handoffPromptSnippet } from '@/views/SearchView/composables/promptSnippetHandoff';
import { useSearchRequestFlow } from '@/views/SearchView/composables/useSearchRequest';

describe('given Search submits requests to the actual main Core owner', () => {
    it('user sends a widget reply without borrowing unsupported composer attachments or clearing the draft', async () => {
        let cleared = false;
        const view = await mountComposable(
            () =>
                useSearchRequestFlow({
                    modelOverride: ref({ modelId: null, providerId: null }),
                    clearDraft: () => {
                        cleared = true;
                    },
                    getUnsupportedAttachmentMessage: () =>
                        'The active model does not support files.',
                    getUnsupportedAttachmentMessageFor: (attachments) =>
                        attachments.length ? 'The active model does not support files.' : null,
                    getCurrentInputSnapshot: (text) =>
                        createInputHistorySnapshot({
                            text,
                            attachments: [
                                {
                                    id: 'composer-file',
                                    type: 'file',
                                    path: '/draft/private.txt',
                                    originPath: '/draft/private.txt',
                                    name: 'private.txt',
                                    supportStatus: 'unsupported-file',
                                },
                            ],
                        }),
                }),
            (app) => app.provide(agentApiKey, searchRequestFixture().window.api)
        );
        try {
            network.replies.push(response('Widget answer'));
            await view.result.handleSubmit(
                'Widget reply',
                createInputHistorySnapshot({ text: 'Widget reply', attachments: [] }),
                undefined,
                { preserveComposerDraft: true }
            );
            expect(cleared).toBe(false);
            expect(network.requests).toHaveLength(1);
            expect(JSON.stringify(network.requests[0]?.messages)).toContain('Widget reply');
            expect(JSON.stringify(network.requests[0]?.messages)).not.toContain('private.txt');
        } finally {
            view.unmount();
        }
    });

    it('user submits during initial task startup and keeps the second draft when no session can accept it', async () => {
        const { result, cleared } = await mountSearchFlow();
        network.replies.push(response('First answer'));
        const first = result.handleSubmit('Initial prompt');
        await result.handleSubmit('Keep this draft');
        expect(cleared()).toBe(1);
        expect(result.pendingUserMessages.value).toEqual([]);
        await first;
        expect(network.requests).toHaveLength(1);
        expect(JSON.stringify(network.requests[0]?.messages)).not.toContain('Keep this draft');
    });

    it('user inserts a priority prompt and removes the latest queued message while the reply stays active', async () => {
        const { result } = await mountSearchFlow();
        const channel = streamingResponse();
        network.replies.push(channel.response);
        const first = result.handleSubmit('Initial prompt');
        await expect.poll(() => network.requests.length).toBe(1);
        await result.handleSubmit('Insert this', undefined, 'enter-modified');
        await result.handleSubmit('Remove this');
        await expect
            .poll(() => result.pendingUserMessages.value.map((message) => message.delivery))
            .toEqual(['priority', 'queue']);
        expect(result.cancelLatestPendingMessage()).toBe(true);
        await expect
            .poll(() => result.pendingUserMessages.value.map((message) => message.prompt))
            .toEqual(['Insert this']);
        expect(result.isLoading.value).toBe(true);
        expect(result.cancelPendingRequest()).toBe(true);
        await expect.poll(() => result.pendingUserMessages.value).toEqual([]);
        expect(result.cancelLatestPendingMessage()).toBe(false);
        await finishSearch(channel);
        await first;
        expect(network.requests).toHaveLength(1);
    });

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

    it('user queues multiple follow-ups and each starts in order after the previous answer commits', async () => {
        const { result, cleared } = await mountSearchFlow();
        const channel = streamingResponse();
        network.replies.push(
            channel.response,
            response('Follow-up answer'),
            response('Last answer')
        );
        const first = result.handleSubmit('first question');
        await expect.poll(() => network.requests.length).toBe(1);
        await result.handleSubmit('queued follow-up');
        await result.handleSubmit('another queued prompt');
        await expect.poll(() => result.pendingUserMessages.value.length).toBe(2);
        expect(result.pendingRequest.value?.query).toBe('queued follow-up');
        expect(network.requests).toHaveLength(1);
        channel.delta({ role: 'assistant', content: 'First answer' });
        channel.finish();
        await first;
        await expect.poll(() => network.requests.length).toBe(3);
        await expect.poll(() => result.isLoading.value).toBe(false);
        expect(JSON.stringify(network.requests[1]?.messages)).toContain('queued follow-up');
        expect(JSON.stringify(network.requests[1]?.messages)).not.toContain(
            'another queued prompt'
        );
        expect(JSON.stringify(network.requests[2]?.messages)).toContain('another queued prompt');
        expect(result.pendingUserMessages.value).toEqual([]);
        expect(
            result.sessionHistory.value.some((message) => message.content === 'Last answer')
        ).toBe(true);
        expect(cleared()).toBe(3);
    });

    it('user inserts a snippet while another reply is running and sees the full draft queued once', async () => {
        const { result } = await mountSearchFlow();
        const channel = streamingResponse();
        network.replies.push(channel.response, response('Snippet answer'));
        const first = result.handleSubmit('Keep working');
        await expect.poll(() => network.requests.length).toBe(1);

        let draft = createInputHistorySnapshot({
            text: 'Existing context: ',
            attachments: [],
        });
        await handoffPromptSnippet({
            body: 'Summarize the current state.',
            insertionMode: 'paste_and_send',
            insertTextAtCursor: (body) => {
                draft = createInputHistorySnapshot({
                    ...draft,
                    text: `${draft.text}${body}`,
                });
            },
            captureInputSnapshot: () => draft,
            closePicker: vi.fn().mockResolvedValue(undefined),
            submit: (snapshot) => result.handleSubmit(snapshot.text, snapshot),
        });

        await expect
            .poll(() => result.pendingUserMessages.value.map((message) => message.prompt))
            .toEqual(['Existing context: Summarize the current state.']);
        expect(network.requests).toHaveLength(1);

        channel.delta({ role: 'assistant', content: 'Still working' });
        channel.finish();
        await first;
        await expect.poll(() => network.requests.length).toBe(2);
        expect(JSON.stringify(network.requests[1]?.messages)).toContain(
            'Existing context: Summarize the current state.'
        );
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

    it('user cancels the active task and the next queued prompt starts once without accepting late output', async () => {
        const { result } = await mountSearchFlow();
        const channel = streamingResponse();
        const nextChannel = streamingResponse();
        network.replies.push(channel.response, nextChannel.response);
        const first = result.handleSubmit('cancel me');
        await expect.poll(() => network.requests.length).toBe(1);
        await result.handleSubmit('queued prompt');
        result.cancelRequest();
        await first;
        await expect.poll(() => network.requests.length).toBe(2);
        expect(JSON.stringify(network.requests[1]?.messages)).toContain('queued prompt');
        channel.delta({ role: 'assistant', content: 'late answer' });
        channel.finish();
        nextChannel.delta({ role: 'assistant', content: 'Queued answer' });
        nextChannel.finish();
        await expect.poll(() => searchRequestFixture().window.api.listActiveTasks()).toEqual([]);
        await expect.poll(() => result.isLoading.value).toBe(false);
        expect(result.pendingRequest.value).toBeNull();
        expect(result.pendingUserMessages.value).toEqual([]);
        expect(
            result.sessionHistory.value.some((message) => message.content === 'Queued answer')
        ).toBe(true);
        expect(JSON.stringify(result.sessionHistory.value)).not.toContain('late answer');
        expect(network.requests).toHaveLength(2);
    });

    it('user receives a failed request and can still edit or remove the queued prompt', async () => {
        const { result } = await mountSearchFlow();
        const reply = Promise.withResolvers<Response>();
        network.respondToGeneration = () => reply.promise;
        const first = result.handleSubmit('authentication fails');
        await expect.poll(() => network.requests.length).toBe(1);
        await result.handleSubmit('keep after failure');
        reply.resolve(new Response('{}', { status: 401 }));
        await first;
        expect(result.error.value).toBeInstanceOf(Error);
        expect(result.pendingRequest.value?.query).toBe('keep after failure');
        expect(
            result.updatePendingUserMessage(result.pendingUserMessages.value[0]!.id, {
                prompt: 'edited after failure',
            })
        ).toBe(true);
        expect(result.cancelPendingRequest()).toBe(true);
        await expect.poll(() => result.pendingUserMessages.value.length).toBe(0);
        expect(network.requests).toHaveLength(1);
    });

    it('user switches conversations while a task runs and its queue continues without taking over the new view', async () => {
        const { result, modelOverride } = await mountSearchFlow();
        const channel = streamingResponse();
        network.replies.push(channel.response, response('Background follow-up'));
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
        await expect.poll(() => network.requests.length).toBe(2);
        expect(result.currentSessionId.value).toBe(7);
        expect(result.pendingUserMessages.value).toEqual([]);
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
