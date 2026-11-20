import type { AgentToolScope } from '@touchai/agent-core/contracts';
import { describe, expect, it } from 'vitest';

import { createAgentMessageAdapter } from '@/adapters/agent/messages';
import { createCoreToolsAdapter } from '@/adapters/agent/tools';
import type { ToolInvocationScope, ToolOutcome } from '@/modules/tools';
import { createTools } from '@/modules/tools';

const model = {
    key: 'opaque-model',
    id: 3,
    provider_id: 2,
    provider_name: 'Fixture',
    model_id: 'fixture-model',
    name: 'Fixture',
    supportsImages: true,
};
const approval = {
    title: 'Read fixture',
    description: '',
    command: '/fixture/file',
    riskLabel: '',
    reason: '',
    commandLabel: '',
    approveLabel: 'Approve',
    rejectLabel: 'Reject',
    enterHint: '',
    escHint: '',
};

function scope(messageKey: string, controller = new AbortController()): AgentToolScope {
    return {
        taskId: 'fixture-task',
        attemptToken: 'fixture-attempt',
        attemptGeneration: 1,
        iteration: 0,
        messageKey,
        signal: controller.signal,
        taskSignal: controller.signal,
        cancelTask: () => controller.abort(),
        approve: async () => true,
        ask: async () => null,
    };
}

describe('given a Core task consumes only a frozen Desktop tools execution capability', () => {
    it('user keeps creation-time host callbacks when the caller replaces its history callback', async () => {
        const messages = createAgentMessageAdapter();
        const tools = createTools({
            registrations: [
                {
                    name: 'builtin__read',
                    source: 'builtin',
                    prepare: async () => ({
                        declaration: {
                            name: 'builtin__read',
                            description: 'Read',
                            input_schema: {
                                type: 'object',
                                properties: { path: { type: 'string' } },
                                required: ['path'],
                            },
                        },
                        authorize: async () => true,
                        execute: async (_args, context) => ({
                            result: `read ${context.task?.historyTarget.sessionId}`,
                            isError: false,
                        }),
                    }),
                },
            ],
            formatError: (code) => code,
            beginAudit: async () => ({ finish: async () => {} }),
        });
        try {
            const options = {
                snapshot: await tools.snapshot(),
                messages,
                model,
                historyTarget: () => ({ sessionId: 4, messageId: 17 }),
                present: () => {},
                materialize: async () => [],
            };
            const adapter = createCoreToolsAdapter(options);
            options.historyTarget = () => ({ sessionId: 999, messageId: 999 });
            const current = scope(messages.messageReference(17));
            expect(
                (
                    await adapter.execute(
                        { id: 'valid', name: 'builtin__read', arguments: '{"path":"fixture"}' },
                        current
                    )
                ).result
            ).toBe('read 4');
        } finally {
            tools.dispose();
            messages.dispose();
        }
    });

    it('user sees protocol errors distinguished from a valid object rejected by its business schema', async () => {
        const messages = createAgentMessageAdapter();
        const tools = createTools({
            registrations: [
                {
                    name: 'builtin__read',
                    source: 'builtin',
                    prepare: async () => ({
                        declaration: {
                            name: 'builtin__read',
                            description: 'Read',
                            input_schema: {
                                type: 'object',
                                properties: { path: { type: 'string' } },
                                required: ['path'],
                            },
                        },
                        authorize: async () => true,
                        execute: async () => ({ result: 'read', isError: false }),
                    }),
                },
            ],
            formatError: (code) => code,
            beginAudit: async () => ({ finish: async () => {} }),
        });
        try {
            const adapter = createCoreToolsAdapter({
                snapshot: await tools.snapshot(),
                messages,
                model,
                historyTarget: () => ({ sessionId: 4, messageId: 17 }),
                present: () => {},
                materialize: async () => [],
            });
            const current = scope(messages.messageReference(17));
            expect(
                (
                    await adapter.execute(
                        { id: 'schema', name: 'builtin__read', arguments: '{}' },
                        current
                    )
                ).argumentParseFailed
            ).not.toBe(true);
            expect(
                (
                    await adapter.execute(
                        { id: 'protocol', name: 'builtin__read', arguments: '[]' },
                        current
                    )
                ).argumentParseFailed
            ).toBe(true);
        } finally {
            tools.dispose();
            messages.dispose();
        }
    });

    it('user sees the advertised timeout schema preserved without Desktop runtime metadata entering the model contract', async () => {
        const messages = createAgentMessageAdapter();
        const tools = createTools({
            registrations: [
                {
                    name: 'builtin__read',
                    source: 'builtin',
                    prepare: async () => ({
                        declaration: {
                            name: 'builtin__read',
                            description: 'Read',
                            adaptiveTimeoutCeilingMs: 600_000,
                            input_schema: { type: 'object', properties: {} },
                        },
                        authorize: async () => true,
                        execute: async () => ({ result: 'read', isError: false }),
                    }),
                },
            ],
            formatError: (code) => code,
        });
        try {
            const snapshot = await tools.snapshot();
            const adapter = createCoreToolsAdapter({
                snapshot,
                messages,
                model,
                historyTarget: () => ({ sessionId: 4, messageId: 17 }),
                present: () => {},
                materialize: async () => [],
            });
            expect(adapter.declarations[0]?.input_schema.properties._meta).toEqual(
                snapshot.declarations[0]?.input_schema.properties._meta
            );
            expect(Object.keys(adapter.declarations[0]!)).toEqual([
                'name',
                'description',
                'input_schema',
            ]);
            expect(Object.keys(adapter)).toEqual(['declarations', 'execute']);
        } finally {
            tools.dispose();
            messages.dispose();
        }
    });

    it('user approves an effect through the same task scope and receives task-bound neutral media with its unchanged persisted summary', async () => {
        const messages = createAgentMessageAdapter();
        const messageKey = messages.messageReference(17);
        const stored: ToolOutcome[] = [];
        const tool = createTools({
            registrations: [
                {
                    name: 'builtin__read',
                    source: 'builtin',
                    prepare: async () => ({
                        declaration: {
                            name: 'builtin__read',
                            description: 'Read',
                            input_schema: { type: 'object', properties: {} },
                        },
                        authorize: async () => true,
                        approval: async () => approval,
                        execute: async (_args, context: ToolInvocationScope) => ({
                            result: `read ${context.task?.historyTarget.sessionId}/${context.task?.historyTarget.messageId}`,
                            persistedResult: 'stored summary',
                            isError: false,
                            attachments: [
                                {
                                    id: 'fixture-attachment',
                                    type: 'image',
                                    path: '/fixture/cache',
                                    originPath: '/fixture/original',
                                    name: 'fixture.png',
                                    attachmentId: 9,
                                },
                            ],
                        }),
                    }),
                },
            ],
            formatError: (code) => code,
            beginAudit: async () => ({
                receiptKey: 'fixture-receipt',
                finish: async (outcome) => {
                    stored.push(outcome);
                },
            }),
        });
        const media = {
            type: 'image' as const,
            kind: 'image' as const,
            name: 'fixture.png',
            size: 4,
            mimeType: 'image/png',
            data: 'ZmFrZQ==',
            sourcePath: '/fixture/cache',
            semanticIntent: 'visual-reference' as const,
            meta: {
                alias: 'A1',
                order: 1,
                type: 'image' as const,
                name: 'fixture.png',
                mimeType: 'image/png',
                originPath: '/fixture/original',
                attachmentId: 9,
                hash: 'fixture-hash',
            },
        };
        try {
            const adapter = createCoreToolsAdapter({
                snapshot: await tool.snapshot(),
                messages,
                model,
                historyTarget: (key) => ({ sessionId: 4, messageId: messages.messageId(key) }),
                present: () => {},
                materialize: async () => [media],
            });
            const outcome = await adapter.execute(
                { id: 'read-1', name: 'builtin__read', arguments: '{}' },
                scope(messageKey)
            );
            expect(outcome).toMatchObject({
                result: 'read 4/17',
                persistedResult: 'stored summary',
                receiptKey: 'fixture-receipt',
                sideEffect: 'completed',
            });
            expect(stored.map((item) => item.persistedResult)).toEqual(['stored summary']);
            expect(messages.toDesktopContent(outcome.content!)).toEqual([
                { type: 'text', text: 'read 4/17' },
                media,
            ]);
            expect(messages.toDesktopContent(outcome.persistedContent!)).toEqual([
                { type: 'text', text: 'stored summary' },
                media,
            ]);
            const part = Array.isArray(outcome.content) ? outcome.content[1]! : {};
            expect(Object.keys(part)).not.toEqual(
                expect.arrayContaining(['attachmentId', 'meta', 'sourcePath'])
            );
            const unrelated = createAgentMessageAdapter();
            expect(() => unrelated.toDesktopContent(outcome.content!)).toThrow(
                'RESOURCE_BINDING_NOT_FOUND'
            );
            unrelated.dispose();
        } finally {
            tool.dispose();
            messages.dispose();
        }
    });

    it('user cancels only the scoped task and cannot publish a late effect update into another attempt', async () => {
        const messages = createAgentMessageAdapter();
        const observed: string[] = [];
        const tools = createTools({
            registrations: [
                {
                    name: 'builtin__read',
                    source: 'builtin',
                    prepare: async () => ({
                        declaration: {
                            name: 'builtin__read',
                            description: 'Read',
                            input_schema: { type: 'object', properties: {} },
                        },
                        authorize: async () => true,
                        execute: async (_args, context) => {
                            context.task!.stop();
                            context.task!.present({
                                type: 'result_delta',
                                callId: context.callId!,
                                result: 'late',
                            });
                            return { result: 'late success', isError: false };
                        },
                    }),
                },
            ],
            formatError: (code) => code,
            beginAudit: async () => ({ finish: async () => {} }),
        });
        try {
            const adapter = createCoreToolsAdapter({
                snapshot: await tools.snapshot(),
                messages,
                model,
                historyTarget: () => ({ sessionId: 4, messageId: 17 }),
                present: (event) => {
                    if (event.type === 'result_delta') observed.push(event.result);
                },
                materialize: async () => [],
            });
            const current = scope(messages.messageReference(17));
            const outcome = await adapter.execute(
                { id: 'read-1', name: 'builtin__read', arguments: '{}' },
                current
            );
            expect(current.taskSignal.aborted).toBe(true);
            expect(outcome).toMatchObject({ result: 'request_cancelled', sideEffect: 'unknown' });
            expect(observed).toEqual([]);
        } finally {
            tools.dispose();
            messages.dispose();
        }
    });
});
