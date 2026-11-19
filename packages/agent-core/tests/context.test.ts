import { createAgent } from '@touchai/agent-core';
import type {
    AgentCheckpoint,
    AgentMessage,
    ContextSummaryRecord,
} from '@touchai/agent-core/contracts';
import { describe, expect, it } from 'vitest';

import { fixtureHost, memoryPersistence, text, tools } from './fixtures';

function history(): AgentMessage[] {
    return [
        {
            role: 'system',
            content: 'fixture system',
            origin: { key: 'system', order: 1, fingerprint: 'system-proof' },
        },
        ...Array.from(
            { length: 10 },
            (_, index): AgentMessage => ({
                role: index % 2 ? 'assistant' : 'user',
                content: 'earlier data '.repeat(150),
                origin: {
                    key: `message-${index}`,
                    order: index + 2,
                    fingerprint: `proof-${index}`,
                },
            })
        ),
        {
            role: 'user',
            content: 'current authorized request',
            origin: { key: 'current', order: 12, fingerprint: 'current-proof' },
        },
    ];
}

describe('given legal compaction boundaries and deterministic prompt fragments', () => {
    it('user continues after compaction with the latest request verbatim and a committed neutral summary', async () => {
        const summaries: ContextSummaryRecord[] = [];
        const store = memoryPersistence();
        const requests: AgentMessage[][] = [];
        const fixture = fixtureHost({
            prepare: () => ({
                messages: history(),
                model: {
                    key: 'one',
                    model: 'one',
                    connectionKey: 'profile-one',
                    contextLimit: 4000,
                    outputLimit: 1000,
                    supportsTools: true,
                    supportsReasoning: false,
                },
            }),
            persistence: {
                ...store.persistence,
                saveSummary: async (summary) => {
                    summaries.push(summary);
                    return 'opaque-summary-record';
                },
            },
            stream: async function* (request) {
                if (request.toolChoice === 'none')
                    yield* text('Earlier progress, constraints and unresolved work.');
                else {
                    requests.push(request.messages);
                    yield* text('continued');
                }
            },
        });
        const agent = createAgent(fixture.host);
        expect(
            (await agent.start({ prompt: 'current authorized request' }).completion).response
        ).toBe('continued');
        expect(requests[0]?.at(-1)?.content).toBe('current authorized request');
        expect(summaries[0]?.systemMessageKeys).toEqual(['system']);
        const keptIndex = history().findIndex(
            (message) => message.origin?.key === summaries[0]?.firstKeptMessageKey
        );
        expect(keptIndex).toBeGreaterThan(0);
        expect(requests[0]?.slice(2).map((message) => message.content)).toEqual(
            history()
                .slice(keptIndex)
                .map((message) => message.content)
        );
        expect(Object.keys(summaries[0]!)).not.toEqual(
            expect.arrayContaining(['version', 'firstKeptMessageId', 'providerId'])
        );
        await agent.dispose();
    });

    it('user does not continue from an incomplete tool exchange or tool-calling summary', async () => {
        const fixture = fixtureHost({
            prepare: () => ({
                messages: history(),
                model: {
                    key: 'one',
                    model: 'one',
                    connectionKey: 'one',
                    contextLimit: 4000,
                    outputLimit: 1000,
                    supportsTools: true,
                    supportsReasoning: false,
                },
            }),
            stream: async function* () {
                yield* tools();
            },
        });
        const agent = createAgent(fixture.host);
        await expect(agent.start({ prompt: 'current request' }).completion).rejects.toMatchObject({
            code: 'CONTEXT_COMPACTION_FAILED',
        });
        expect(fixture.store.results).toEqual([]);
        await agent.dispose();
    });

    it('user sees the same instruction ordering regardless of host fragment order without Core discovering files', async () => {
        const fixture = fixtureHost({
            prepare: () => ({
                promptFragments: [
                    { source: 'user_append', content: ' user append ' },
                    { source: 'policy', content: 'policy' },
                    { source: 'platform', content: 'platform' },
                    { source: 'override', content: 'override' },
                ],
            }),
            stream: async function* () {
                yield* text('answer');
            },
        });
        const agent = createAgent(fixture.host);
        await agent.start({ prompt: 'question' }).completion;
        expect(fixture.requests[0]?.messages[0]?.content).toBe(
            'override\n\nplatform\n\npolicy\n\nuser append'
        );
        await agent.dispose();
    });

    it('user retains private semantic tool text during execution without persisting it in checkpoints', async () => {
        const fixture = fixtureHost({
            stream: async function* (request) {
                if (!request.messages.some((message) => message.role === 'tool')) yield* tools();
                else {
                    expect(request.messages.at(-1)?.content).toBe('private loaded content');
                    yield* text('done');
                }
            },
            execute: async () => ({
                result: 'private loaded content',
                persistedResult: 'loaded resource summary',
                isError: false,
                sideEffect: 'none',
            }),
        });
        const agent = createAgent(fixture.host);
        await agent.start({ prompt: 'load resource' }).completion;
        expect(fixture.store.checkpoints[0]?.messages.at(-1)?.content).toBe(
            'loaded resource summary'
        );
        expect(JSON.stringify(fixture.store.checkpoints)).not.toContain('private loaded content');
        await agent.dispose();
    });

    it('user keeps private assembled instructions out of committed and published checkpoints while the model receives them', async () => {
        const store = memoryPersistence();
        const saved: AgentCheckpoint[] = [];
        const published: AgentCheckpoint[] = [];
        const fixture = fixtureHost({
            prepare: () => ({
                promptFragments: [{ source: 'policy', content: 'private instruction fixture' }],
            }),
            persistence: {
                ...store.persistence,
                start: async (checkpoint, scope) => {
                    saved.push(structuredClone(checkpoint));
                    return store.persistence.start(checkpoint, scope);
                },
            },
            stream: async function* (request) {
                expect(request.messages[0]?.content).toBe('private instruction fixture');
                if (!request.messages.some((message) => message.role === 'tool')) yield* tools();
                else yield* text('done');
            },
        });
        const agent = createAgent(fixture.host);
        try {
            const task = agent.start({ prompt: 'question' });
            agent.subscribe(task.taskId, (event) => {
                if (event.type === 'checkpoint_committed') published.push(event.checkpoint);
            });
            await task.completion;
            for (const checkpoint of [...saved, ...store.checkpoints, ...published]) {
                expect(checkpoint.messages[0]?.content).toBe('fixture system');
                expect(JSON.stringify(checkpoint)).not.toContain('private instruction fixture');
            }
            expect(published.length).toBeGreaterThan(0);
        } finally {
            await agent.dispose();
        }
    });
});
