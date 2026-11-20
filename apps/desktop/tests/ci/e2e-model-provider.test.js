import { afterEach, describe, expect, it } from 'vitest';

import {
    createModelProvider,
    latestUserText,
    toolResultsAfterLatestPrompt,
} from '../../e2e-tests/test/support/model-provider.js';

let provider;

afterEach(async () => {
    await provider?.close();
    provider = undefined;
});

function chatPath(path = 'alpha') {
    return `${provider.baseUrl}/${path}/chat/completions`;
}

async function chat(body, path = 'alpha') {
    return fetch(chatPath(path), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: `e2e-${path}`, ...body }),
        signal: AbortSignal.timeout(5000),
    });
}

function streamedText(body) {
    return body
        .split('\n')
        .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
        .map((line) => JSON.parse(line.slice(6)))
        .map((frame) => frame.choices?.[0]?.delta?.content ?? '')
        .join('');
}

describe('user scripts the model the agent talks to', () => {
    it('user receives the scripted answer and sees the request recorded for that prompt', async () => {
        provider = await createModelProvider();
        await provider.respond('hello agent', { answer: 'hello from the scripted model' });

        const response = await chat({
            stream: true,
            messages: [{ role: 'user', content: 'hello agent' }],
        });
        const body = await response.text();

        expect(response.status).toBe(200);
        expect(streamedText(body)).toBe('hello from the scripted model');
        expect(body).toContain('data: [DONE]');

        const [call] = await provider.callsFor('hello agent');
        expect(latestUserText(call)).toBe('hello agent');
        expect(call.path).toBe('/v1/alpha/chat/completions');
        expect(call.model).toBe('e2e-alpha');
        await provider.assertHealthy();
    });

    it('user receives the tool request under the id the script chose and the answer that follows its result', async () => {
        provider = await createModelProvider();
        await provider.respond('read the setting', {
            tool: {
                name: 'builtin__setting',
                args: { action: 'get', keys: ['language'] },
                id: 'e2e-setting-read',
            },
            answer: 'the language is en-US',
        });

        const first = await (
            await chat({
                stream: true,
                tools: [
                    {
                        type: 'function',
                        function: {
                            name: 'builtin__setting',
                            description: 'Read or write one setting.',
                            parameters: {
                                type: 'object',
                                properties: { action: { type: 'string' } },
                            },
                        },
                    },
                ],
                messages: [{ role: 'user', content: 'read the setting' }],
            })
        ).text();

        expect(first).toContain('builtin__setting');
        expect(first).toContain('e2e-setting-read');

        const second = await (
            await chat({
                stream: true,
                messages: [
                    { role: 'user', content: 'read the setting' },
                    {
                        role: 'assistant',
                        content: '',
                        tool_calls: [
                            {
                                id: 'e2e-setting-read',
                                type: 'function',
                                function: {
                                    name: 'builtin__setting',
                                    arguments: JSON.stringify({
                                        action: 'get',
                                        keys: ['language'],
                                    }),
                                },
                            },
                        ],
                    },
                    {
                        role: 'tool',
                        tool_call_id: 'e2e-setting-read',
                        content: '{"language":"en-US"}',
                    },
                ],
            })
        ).text();

        expect(streamedText(second)).toBe('the language is en-US');

        const calls = await provider.callsFor('read the setting');
        expect(calls).toHaveLength(2);
        expect(toolResultsAfterLatestPrompt(calls[1])).toEqual([
            { type: 'tool_result', id: 'e2e-setting-read', output: '{"language":"en-US"}' },
        ]);
    });

    it('user sees an injected failure and a healthy report only when every request matched a rule', async () => {
        provider = await createModelProvider();
        await provider.script([
            {
                id: 'rate-limit',
                match: { textContains: 'retry later' },
                times: 1,
                error: { status: 429, message: 'Injected rate limit.' },
            },
            {
                id: 'recovered',
                match: { textContains: 'retry later' },
                reply: [{ type: 'text', text: 'recovered answer' }],
            },
        ]);

        const limited = await chat({
            messages: [{ role: 'user', content: 'retry later' }],
        });
        expect(limited.status).toBe(429);
        expect(await limited.text()).toContain('Injected rate limit.');
        expect((await provider.callsFor('retry later'))[0].status).toBe(429);

        const recovered = await chat({
            messages: [{ role: 'user', content: 'retry later' }],
        });
        expect(await recovered.text()).toContain('recovered answer');
        await provider.assertHealthy();

        const unscripted = await chat({
            messages: [{ role: 'user', content: 'never scripted' }],
        });
        expect(unscripted.status).toBe(400);
        await expect(provider.assertHealthy()).rejects.toThrow(
            'The model service answered an unscripted request'
        );
    });
});
