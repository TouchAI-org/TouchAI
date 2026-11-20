import { createAgent } from '@touchai/agent-core';
import { createAiSdkStreamProcessor } from '@touchai/models';
import { describe, expect, it } from 'vitest';

import { fixtureHost, memoryPersistence } from './fixtures';

describe.each([
    { provider: 'OpenAI', namespace: 'openai', field: 'reasoningEncryptedContent' },
    { provider: 'Anthropic', namespace: 'anthropic', field: 'signature' },
])(
    'given $provider supplies reasoning replay metadata at the closing boundary',
    ({ namespace, field }) => {
        it.each(['visible reasoning', ''])(
            'user continues a tool round with %j and retains closing metadata in history and the final answer',
            async (reasoning) => {
                const store = memoryPersistence();
                const metadata = (round: number) => ({
                    [namespace]: { [field]: `replay-${round}` },
                });
                let round = 0;
                const fixture = fixtureHost({
                    persistence: store.persistence,
                    stream: async function* () {
                        const current = ++round;
                        const processor = createAiSdkStreamProcessor();
                        yield* processor.consumePart({
                            type: 'reasoning-start',
                            id: `reasoning-${current}`,
                            providerMetadata: { [namespace]: { itemId: `reasoning-${current}` } },
                        });
                        if (reasoning) {
                            yield* processor.consumePart({
                                type: 'reasoning-delta',
                                id: `reasoning-${current}`,
                                text: reasoning,
                            });
                        }
                        yield* processor.consumePart({
                            type: 'reasoning-end',
                            id: `reasoning-${current}`,
                            providerMetadata: metadata(current),
                        });
                        if (current === 1) {
                            yield* processor.consumePart({
                                type: 'tool-call',
                                toolCallId: 'read-one',
                                toolName: 'builtin__read',
                                input: {},
                                dynamic: true,
                            });
                            yield processor.buildFinishChunk('tool-calls');
                        } else {
                            yield* processor.consumePart({
                                type: 'text-delta',
                                id: 'answer',
                                text: 'done',
                            });
                            yield processor.buildFinishChunk('stop');
                        }
                    },
                });
                const agent = createAgent(fixture.host);
                try {
                    expect(
                        (await agent.start({ prompt: 'read and explain' }).completion).response
                    ).toBe('done');
                    const replayPart = {
                        type: 'reasoning',
                        text: reasoning,
                        providerOptions: {
                            [namespace]: { itemId: 'reasoning-1', ...metadata(1)[namespace] },
                        },
                    };
                    expect(
                        fixture.requests[1]?.messages.find(
                            (message) => message.role === 'assistant'
                        )
                    ).toMatchObject({ content: [replayPart] });
                    expect(
                        store.checkpoints[0]?.messages.find(
                            (message) => message.role === 'assistant'
                        )
                    ).toMatchObject({ content: [replayPart] });
                    expect(store.terminals[0]?.outputParts).toEqual([
                        expect.objectContaining({
                            type: 'reasoning',
                            content: reasoning,
                            providerOptions: {
                                [namespace]: { itemId: 'reasoning-2', ...metadata(2)[namespace] },
                            },
                        }),
                        { type: 'text', content: 'done' },
                    ]);
                } finally {
                    await agent.dispose();
                }
            }
        );
    }
);
