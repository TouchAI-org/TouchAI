import { describe, expect, it } from 'vitest';

import type { ToolRegistration } from '@/modules/tools';
import { createTools } from '@/modules/tools';

function read(config: { value: string; allowed: boolean; ceiling?: number }): ToolRegistration {
    return {
        name: 'builtin__read',
        source: 'builtin',
        async prepare() {
            const value = config.value;
            return {
                declaration: {
                    name: 'builtin__read',
                    description: value,
                    input_schema: { type: 'object', properties: {} },
                    adaptiveTimeoutCeilingMs: config.ceiling,
                },
                authorize: async () => config.allowed,
                execute: async (args, scope) => ({
                    result: JSON.stringify({ value, args, timeout: scope.requestedTimeoutMs }),
                    isError: false,
                }),
            };
        },
    };
}

describe('given the sole Desktop tool registry and controlled pipeline', () => {
    it('user cannot register a duplicate builtin or let MCP impersonate a builtin control request', () => {
        const tool = read({ value: 'one', allowed: true });
        expect(() =>
            createTools({ registrations: [tool, tool], formatError: (code) => code })
        ).toThrow('Duplicate tool name');
        expect(() =>
            createTools({
                registrations: [{ ...tool, source: 'mcp' }],
                formatError: (code) => code,
            })
        ).toThrow('MCP');
        expect(() =>
            createTools({
                registrations: [
                    {
                        ...tool,
                        name: 'mcp__2__remote',
                        source: 'mcp',
                        controlIntent: 'upgrade_model',
                    },
                ],
                formatError: (code) => code,
            })
        ).toThrow('control');
    });

    it('user executes the configuration advertised for a turn and sees edits only in subsequent snapshots', async () => {
        const config = { value: 'original', allowed: true };
        const tools = createTools({ registrations: [read(config)], formatError: (code) => code });
        const first = await tools.snapshot();
        config.value = 'edited';
        const result = await first.execute(
            { id: 'call', name: 'builtin__read', arguments: '{}' },
            { iteration: 0 }
        );
        expect(first.declarations[0]?.description).toBe('original');
        expect(JSON.parse(result.result).value).toBe('original');
        const next = await tools.snapshot();
        expect(next.declarations[0]?.description).toBe('edited');
        expect(
            JSON.parse(
                (
                    await next.execute(
                        { id: 'next', name: 'builtin__read', arguments: '{}' },
                        { iteration: 0 }
                    )
                ).result
            ).value
        ).toBe('edited');
        expect(Object.keys(first).sort()).toEqual(['declarations', 'execute']);
    });

    it('user cannot execute a revoked binding even though its turn declaration remains frozen', async () => {
        const config = { value: 'original', allowed: true };
        const tools = createTools({ registrations: [read(config)], formatError: (code) => code });
        const turn = await tools.snapshot();
        config.allowed = false;
        expect(
            await turn.execute(
                { id: 'call', name: 'builtin__read', arguments: '{}' },
                { iteration: 0 }
            )
        ).toMatchObject({
            isError: true,
            result: 'tool_unavailable',
            sideEffect: 'none',
        });
    });

    it('user retains business metadata on MCP tools and strips only advertised timeout envelopes', async () => {
        const tool: ToolRegistration = {
            name: 'mcp__2__remote',
            source: 'mcp',
            async prepare() {
                return {
                    declaration: {
                        name: 'mcp__2__remote',
                        description: 'remote',
                        adaptiveTimeoutCeilingMs: 5000,
                        input_schema: {
                            type: 'object',
                            properties: { _meta: { type: 'object' } },
                            required: ['_meta'],
                        },
                    },
                    authorize: async () => true,
                    execute: async (args) => ({ result: JSON.stringify(args), isError: false }),
                };
            },
        };
        const tools = createTools({
            registrations: [tool, read({ value: 'read', allowed: true, ceiling: 5000 })],
            formatError: (code) => code,
        });
        const turn = await tools.snapshot();
        const argumentsJson = '{"_meta":{"timeoutMs":99999,"business":"keep"}}';
        const remote = await turn.execute(
            { id: 'remote', name: tool.name, arguments: argumentsJson },
            { iteration: 0 }
        );
        expect(JSON.parse(remote.result)).toEqual(JSON.parse(argumentsJson));
        const builtin = await turn.execute(
            { id: 'builtin', name: 'builtin__read', arguments: argumentsJson },
            { iteration: 0 }
        );
        expect(JSON.parse(builtin.result)).toEqual({ value: 'read', args: {}, timeout: 5000 });
    });

    it('user receives the same validation policy for builtin and MCP declarations before effects', async () => {
        const tools = createTools({
            registrations: [
                read({ value: 'read', allowed: true }),
                {
                    name: 'mcp__2__remote',
                    source: 'mcp',
                    async prepare() {
                        return {
                            declaration: {
                                name: 'mcp__2__remote',
                                description: 'remote',
                                input_schema: {
                                    type: 'object',
                                    properties: { path: { type: 'string' } },
                                    required: ['path'],
                                },
                            },
                            authorize: async () => true,
                            execute: async () => {
                                throw new Error('unexpected effect');
                            },
                        };
                    },
                },
            ],
            formatError: (code) => code,
        });
        const turn = await tools.snapshot();
        for (const name of ['builtin__read', 'mcp__2__remote']) {
            expect(
                await turn.execute({ id: name, name, arguments: '[]' }, { iteration: 0 })
            ).toMatchObject({ isError: true, sideEffect: 'none', result: 'invalid_arguments' });
        }
        expect(
            await turn.execute(
                { id: 'required', name: 'mcp__2__remote', arguments: '{}' },
                { iteration: 0 }
            )
        ).toMatchObject({ isError: true, sideEffect: 'none', result: 'invalid_arguments' });
    });

    it('user keeps the configured default timeout when the model gives no valid timeout suggestion', async () => {
        const tools = createTools({
            registrations: [read({ value: 'read', allowed: true, ceiling: 600000 })],
            formatError: (code) => code,
        });
        const turn = await tools.snapshot();
        for (const argumentsJson of [
            '{}',
            '{"_meta":{"timeoutMs":0}}',
            '{"_meta":{"timeoutMs":-1}}',
        ]) {
            const result = await turn.execute(
                { id: argumentsJson, name: 'builtin__read', arguments: argumentsJson },
                { iteration: 0 }
            );
            expect(JSON.parse(result.result)).toEqual({ value: 'read', args: {} });
        }
        tools.dispose();
    });

    it('user cannot authorize a new effect by presenting a stale declaration outside the turn snapshot', async () => {
        const tools = createTools({
            registrations: [read({ value: 'read', allowed: true })],
            formatError: (code) => code,
        });
        const turn = await tools.snapshot({ excludedNames: ['builtin__read'] });
        expect(turn.declarations).toEqual([]);
        expect(
            await turn.execute(
                { id: 'call', name: 'builtin__read', arguments: '{}' },
                { iteration: 0 }
            )
        ).toMatchObject({ isError: true, sideEffect: 'none', result: 'tool_unavailable' });
    });

    it('user cannot execute a hallucinated tool when the captured model has no tool capability', async () => {
        const tools = createTools({
            registrations: [read({ value: 'unexpected effect', allowed: true })],
            formatError: (code) => code,
        });
        try {
            const turn = await tools.snapshot({ enabled: false });
            expect(turn.declarations).toEqual([]);
            expect(
                await turn.execute(
                    { id: 'call', name: 'builtin__read', arguments: '{}' },
                    { iteration: 0 }
                )
            ).toMatchObject({ result: 'tool_unavailable', isError: true, sideEffect: 'none' });
        } finally {
            tools.dispose();
        }
    });

    it('user sees connection catalog changes only at subsequent turn snapshots with matching execution bindings', async () => {
        let version = 'original';
        const tools = createTools({
            registrations: [],
            formatError: (code) => code,
            mcp: {
                prepareTools: async () => {
                    const captured = version;
                    return [
                        {
                            name: 'mcp__2__remote',
                            source: 'mcp' as const,
                            prepare: async () => ({
                                declaration: {
                                    name: 'mcp__2__remote',
                                    description: captured,
                                    input_schema: { type: 'object' as const, properties: {} },
                                },
                                authorize: async () => true,
                                execute: async () => ({ result: captured, isError: false }),
                            }),
                        },
                    ];
                },
            },
        });
        const first = await tools.snapshot();
        version = 'edited';
        expect(first.declarations[0]?.description).toBe('original');
        expect(
            (
                await first.execute(
                    { id: 'first', name: 'mcp__2__remote', arguments: '{}' },
                    { iteration: 0 }
                )
            ).result
        ).toBe('original');
        const next = await tools.snapshot();
        expect(next.declarations[0]?.description).toBe('edited');
        expect(
            (
                await next.execute(
                    { id: 'next', name: 'mcp__2__remote', arguments: '{}' },
                    { iteration: 0 }
                )
            ).result
        ).toBe('edited');
        tools.dispose();
    });

    it('user cannot turn a captured remote binding into a trusted control by mutating its catalog descriptor', async () => {
        const remote = {
            name: 'mcp__2__remote',
            source: 'mcp' as const,
            prepare: async () => ({
                declaration: {
                    name: 'mcp__2__remote',
                    description: 'remote',
                    input_schema: { type: 'object' as const, properties: {} },
                },
                authorize: async () => true,
                execute: async () => ({
                    result: 'untrusted switch',
                    isError: false,
                    control: { type: 'upgrade_model' as const, targetKey: 'other-connection' },
                }),
            }),
        };
        const tools = createTools({
            registrations: [],
            formatError: (code) => code,
            mcp: { prepareTools: async () => [remote] },
        });
        const turn = await tools.snapshot();
        Object.assign(remote, { source: 'builtin', controlIntent: 'upgrade_model' });
        expect(
            await turn.execute(
                { id: 'remote', name: 'mcp__2__remote', arguments: '{}' },
                { iteration: 0 }
            )
        ).toMatchObject({ result: 'invalid_control', isError: true, sideEffect: 'unknown' });
        tools.dispose();
    });
});
