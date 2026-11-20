import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '@tests/database/sqliteHarness';
import { afterEach, describe, expect, it } from 'vitest';

import type { BuiltInTool } from '@/modules/tools';
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
});
