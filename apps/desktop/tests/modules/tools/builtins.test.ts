import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '@tests/database/sqliteHarness';
import { afterEach, describe, expect, it } from 'vitest';

import type { AdditionalBuiltInRegistration, BuiltInTool, ToolRegistration } from '@/modules/tools';
import { createBuiltinRegistrations, createTools } from '@/modules/tools';

afterEach(closeTestDatabases);

function descriptor(): BuiltInTool<{ label: string }> {
    return {
        id: 'bash',
        displayName: 'Bash',
        description: 'fixture',
        inputSchema: { type: 'object', properties: {} },
        defaultConfig: { label: 'original' },
        parseConfig: (text) => JSON.parse(text ?? '{"label":"original"}'),
        prepareForTurn: async function () {
            return this;
        },
        isAuthorized: async () => true,
        buildToolDefinition: (name, config) => ({
            name,
            description: config.label,
            input_schema: { type: 'object', properties: {} },
        }),
        buildConversationSemantic: () => ({ action: 'run', target: 'fixture' }),
        buildConversationSemanticWithContext: (_args, config) => ({
            action: 'run',
            target: config.label,
        }),
        buildApprovalRequest: (_args, config) => ({
            title: config.label,
            description: '',
            command: config.label,
            riskLabel: 'high',
            reason: '',
            commandLabel: '',
            approveLabel: '',
            rejectLabel: '',
            enterHint: '',
            escHint: '',
        }),
        recordApprovalRejected: () => undefined,
        execute: async (_args, config) => ({
            result: config.label,
            isError: false,
            status: 'success',
        }),
    };
}

function additionalRegistration(): ToolRegistration {
    return {
        name: 'builtin__fixture_extra',
        source: 'builtin',
        async prepare() {
            return {
                declaration: {
                    name: 'builtin__fixture_extra',
                    description: 'Fixture extra tool.',
                    input_schema: { type: 'object', properties: {} },
                },
                authorize: async () => true,
                execute: async () => ({
                    result: 'extra result',
                    isError: false,
                    status: 'success',
                }),
            };
        },
    };
}

function additional(
    overrides: Partial<AdditionalBuiltInRegistration> = {}
): AdditionalBuiltInRegistration {
    return {
        id: 'fixture_extra',
        displayName: 'Fixture extra',
        description: 'Fixture extra tool.',
        riskLevel: 'medium',
        defaultConfig: { mode: 'read' },
        registration: additionalRegistration(),
        ...overrides,
    };
}

describe('given instance-created builtin descriptors and the shipped configuration writer', () => {
    it('user keeps declarations, approval and effects paired while later turns see edited configuration', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        const catalog = createBuiltinRegistrations([descriptor()]);
        await catalog.synchronize();
        const approvals: string[] = [];
        const tools = createTools({
            registrations: catalog.registrations,
            formatError: (code) => code,
        });
        try {
            const first = await tools.snapshot();
            database.exec(
                `UPDATE built_in_tools SET config_json = '{"label":"edited"}' WHERE tool_id = 'bash'`
            );
            const result = await first.execute(
                { id: 'first', name: 'builtin__bash', arguments: '{}' },
                {
                    iteration: 0,
                    requestApproval: async (_id, approval) => {
                        approvals.push(approval.title);
                        return true;
                    },
                }
            );
            expect(first.declarations[0]?.description).toBe('original');
            expect(approvals).toEqual(['original']);
            expect(result).toMatchObject({ result: 'original', isError: false });
            const next = await tools.snapshot();
            expect(next.declarations[0]?.description).toBe('edited');
        } finally {
            tools.dispose();
        }
    });

    it('user cannot approve an effect after disabling the builtin in an already prepared turn', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        const catalog = createBuiltinRegistrations([descriptor()]);
        await catalog.synchronize();
        const tools = createTools({
            registrations: catalog.registrations,
            formatError: (code) => code,
        });
        try {
            const snapshot = await tools.snapshot();
            const result = await snapshot.execute(
                { id: 'call', name: 'builtin__bash', arguments: '{}' },
                {
                    iteration: 0,
                    requestApproval: async () => {
                        database.exec(
                            "UPDATE built_in_tools SET enabled = 0 WHERE tool_id = 'bash'"
                        );
                        return true;
                    },
                }
            );
            expect(result).toMatchObject({ result: 'tool_unavailable', sideEffect: 'none' });
            expect((await tools.snapshot()).declarations).toEqual([]);
        } finally {
            tools.dispose();
        }
    });

    it('user gets a duplicate-name error before a second builtin can overwrite the registered effect', () => {
        expect(() => createBuiltinRegistrations([descriptor(), descriptor()])).toThrow(
            'Duplicate tool name: builtin__bash'
        );
    });

    it('user sees an additional builtin registered, persisted, and invoked while enabled', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        const catalog = createBuiltinRegistrations([], [additional()]);
        await catalog.synchronize();
        const tools = createTools({
            registrations: catalog.registrations,
            formatError: (code) => code,
        });
        try {
            const snapshot = await tools.snapshot();
            expect(snapshot.declarations).toContainEqual(
                expect.objectContaining({
                    name: 'builtin__fixture_extra',
                    description: 'Fixture extra tool.',
                })
            );

            const result = await snapshot.execute(
                {
                    id: 'extra-call',
                    name: 'builtin__fixture_extra',
                    arguments: '{}',
                },
                { iteration: 1 }
            );
            expect(result).toMatchObject({
                result: 'extra result',
                isError: false,
                sideEffect: 'completed',
            });
            expect(
                database
                    .prepare(
                        "SELECT risk_level, config_json, last_used_at FROM built_in_tools WHERE tool_id = 'fixture_extra'"
                    )
                    .get()
            ).toMatchObject({
                risk_level: 'medium',
                config_json: '{"mode":"read"}',
                last_used_at: expect.any(String),
            });

            database.exec("UPDATE built_in_tools SET enabled = 0 WHERE tool_id = 'fixture_extra'");
            expect((await tools.snapshot()).declarations).toEqual([]);
            expect(
                await snapshot.execute(
                    {
                        id: 'disabled-extra-call',
                        name: 'builtin__fixture_extra',
                        arguments: '{}',
                    },
                    { iteration: 1 }
                )
            ).toMatchObject({
                isError: true,
                failureCode: 'tool_unavailable',
                sideEffect: 'none',
            });
        } finally {
            tools.dispose();
        }
    });

    it('user sees an additional builtin declaration omitted when its own preparation declines', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        const catalog = createBuiltinRegistrations(
            [],
            [
                additional({
                    registration: {
                        ...additionalRegistration(),
                        prepare: async () => null,
                    },
                }),
            ]
        );
        await catalog.synchronize();
        const tools = createTools({
            registrations: catalog.registrations,
            formatError: (code) => code,
        });
        try {
            expect((await tools.snapshot()).declarations).toEqual([]);
        } finally {
            tools.dispose();
        }
    });

    it('user gets a namespacing error before an additional builtin can use another tool name', () => {
        expect(() =>
            createBuiltinRegistrations(
                [],
                [
                    additional({
                        id: 'fixture_extra',
                        registration: {
                            ...additionalRegistration(),
                            name: 'fixture_extra',
                        },
                    }),
                ]
            )
        ).toThrow('Builtin registration name must be builtin__fixture_extra');
    });

    it('user gets a duplicate-name error before an additional builtin can overwrite a shipped tool', () => {
        expect(() =>
            createBuiltinRegistrations(
                [descriptor()],
                [
                    additional({
                        id: 'bash',
                        registration: {
                            ...additionalRegistration(),
                            name: 'builtin__bash',
                        },
                    }),
                ]
            )
        ).toThrow('Duplicate tool name: builtin__bash');
    });
});
