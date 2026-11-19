import { afterEach, describe, expect, it } from 'vitest';

import { createAgentStreamServer, deferred } from '../../e2e-tests/test/support/agent-stream.js';

let server;

afterEach(async () => {
    await server?.close();
    server = undefined;
});

function requestAnswer(prompt) {
    return fetch(`${server.endpoint}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            model: server.modelId,
            stream: true,
            messages: [{ role: 'user', content: prompt }],
        }),
        signal: AbortSignal.timeout(5000),
    });
}

describe('user exercises streamed model responses through a local endpoint', () => {
    it('user given a successful response when requesting an answer then receives its text and completion marker', async () => {
        server = await createAgentStreamServer();
        server.planNext(({ stream }) => {
            stream.text('A complete answer.');
            stream.finish();
        });

        const response = await requestAnswer('A normal prompt');
        const body = await response.text();

        expect(response.status).toBe(200);
        expect(body).toContain('A complete answer.');
        expect(body).toContain('data: [DONE]');
        expect(server.requests[0].userTexts).toEqual(['A normal prompt']);
        expect(server.protocolError).toBeNull();
    });

    it('user given a partial answer when the connection drops then receives a transport failure rather than a successful completion', async () => {
        server = await createAgentStreamServer();
        const disconnect = deferred();
        server.planNext(async ({ stream }) => {
            stream.text('An interrupted answer.');
            await disconnect.promise;
            stream.disconnect();
        });

        const response = await requestAnswer('An interrupted prompt');
        const body = response.text();
        const failure = expect(body).rejects.toThrow();
        disconnect.resolve();

        await failure;
        expect(server.requests[0].userTexts).toEqual(['An interrupted prompt']);
        expect(server.protocolError).toBeNull();
    });

    it('user given an earlier connection failure when requesting another answer then receives the next planned response', async () => {
        server = await createAgentStreamServer();
        const disconnect = deferred();
        server.planNext(async ({ stream }) => {
            stream.text('Interrupted.');
            await disconnect.promise;
            stream.disconnect();
        });
        server.planNext(({ stream }) => {
            stream.text('Recovered.');
            stream.finish();
        });

        const failedResponse = await requestAnswer('First prompt');
        const failure = expect(failedResponse.text()).rejects.toThrow();
        disconnect.resolve();
        await failure;
        const recoveredResponse = await requestAnswer('Second prompt');

        expect(await recoveredResponse.text()).toContain('Recovered.');
        expect(server.requests.map((request) => request.userTexts)).toEqual([
            ['First prompt'],
            ['Second prompt'],
        ]);
        expect(server.protocolError).toBeNull();
    });
});
