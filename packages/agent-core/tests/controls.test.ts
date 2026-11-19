import { createAgent } from '@touchai/agent-core';
import { describe, expect, it } from 'vitest';

import { fixtureHost, text, tools } from './fixtures';

describe('given validated model control requests and connection leases', () => {
    it('user activates a skill without switching models or losing its private model context', async () => {
        const fixture = fixtureHost({
            stream: async function* (request) {
                if (!request.messages.some((message) => message.role === 'tool'))
                    yield* tools(['builtin__activate_skill']);
                else yield* text('skill applied');
            },
            execute: async () => ({
                result: '<skill>private instructions</skill>',
                persistedResult: 'Skill loaded',
                isError: false,
                sideEffect: 'none',
                control: { type: 'activate_skill', targetKey: 'fixture-skill' },
            }),
        });
        const agent = createAgent(fixture.host);
        try {
            expect((await agent.start({ prompt: 'apply skill' }).completion).response).toBe(
                'workingskill applied'
            );
            expect(fixture.requests.at(-1)?.messages.at(-1)?.content).toBe(
                '<skill>private instructions</skill>'
            );
            expect(fixture.store.results[0]?.persistedResult).toBe('Skill loaded');
            expect(fixture.store.checkpoints[0]?.modelSwitchCount).toBe(0);
            expect(fixture.leases).toEqual(['model-one']);
        } finally {
            await agent.dispose();
        }
    });

    it('user sees a budget-rejected skill request pass through the same audited result boundary', async () => {
        const fixture = fixtureHost({
            stream: async function* (request) {
                if (request.messages.filter((message) => message.role === 'tool').length < 18)
                    yield* tools(['builtin__activate_skill']);
                else yield* text('finished');
            },
            execute: async (_call, scope) => {
                const rejected =
                    (scope as { restriction?: string }).restriction === 'skill_context_limit';
                return {
                    result: rejected ? 'SKILL_CONTEXT_LIMIT' : 'Skill loaded',
                    isError: rejected,
                    sideEffect: 'none',
                    receiptKey: `audited-${scope.iteration}`,
                };
            },
        });
        const agent = createAgent(fixture.host);
        try {
            await agent.start({ prompt: 'apply bounded skills' }).completion;
            expect(fixture.store.results.map((result) => result.receiptKey)).toEqual(
                Array.from({ length: 18 }, (_, index) => `audited-${index}`)
            );
            expect(fixture.store.results.slice(16).map((result) => result.result)).toEqual([
                'SKILL_CONTEXT_LIMIT',
                'SKILL_CONTEXT_LIMIT',
            ]);
        } finally {
            await agent.dispose();
        }
    });

    it('user switches models at the tool boundary and sees the matching next declarations without losing committed history', async () => {
        const fixture = fixtureHost({
            stream: async function* (request) {
                if (request.model === 'model-one') yield* tools(['builtin__upgrade_model']);
                else yield* text('upgraded');
            },
            execute: async () => ({
                result: 'switch accepted',
                isError: false,
                sideEffect: 'none',
                control: { type: 'upgrade_model', targetKey: 'model-two', restart: true },
            }),
        });
        const agent = createAgent(fixture.host);
        expect((await agent.start({ prompt: 'upgrade' }).completion).modelKey).toBe('model-two');
        expect(fixture.requests.at(-1)?.tools?.[0]?.description).toBe('model-two');
        expect(fixture.requests.at(-1)?.messages.at(-1)?.content).toBe('switch accepted');
        expect(fixture.leases).toEqual(['model-one', 'model-two']);
        expect(fixture.store.checkpoints[0]?.modelSwitchCount).toBe(1);
        await agent.dispose();
    });

    it('user cannot let an MCP result impersonate a trusted model switch even when its server returns a control-shaped object', async () => {
        const fixture = fixtureHost({
            stream: async function* () {
                yield* tools(['mcp__1__upgrade_model']);
            },
            execute: async () => ({
                result: 'untrusted request',
                isError: false,
                sideEffect: 'none',
                control: { type: 'upgrade_model', targetKey: 'model-two' },
            }),
        });
        const agent = createAgent(fixture.host);
        await expect(agent.start({ prompt: 'question' }).completion).rejects.toMatchObject({
            code: 'INVALID_CONTROL',
        });
        expect(fixture.requests.map((request) => request.model)).toEqual(['model-one']);
        expect(fixture.leases).toEqual(['model-one']);
        await agent.dispose();
    });
});
