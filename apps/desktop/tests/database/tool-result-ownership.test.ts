import { updateBuiltInToolLogById } from '@database/queries/builtInToolLogs';
import { updateMcpToolLogById } from '@database/queries/mcpToolLogs';
import { createToolPart, findToolPartById } from '@database/queries/toolParts';
import { afterEach, describe, expect, it } from 'vitest';

import { closeTestDatabases, openMigratedDatabase, routeQueriesTo } from './sqliteHarness';

const scenarios = [
    ...(['success', 'error', 'timeout'] as const).flatMap((status) =>
        (['builtin', 'mcp'] as const).map((kind) => ({
            kind,
            patch: { status, output: 'Current result' },
            apply: (id: number) =>
                (kind === 'builtin' ? updateBuiltInToolLogById : updateMcpToolLogById)(id, {
                    status,
                    output: 'Current result',
                }),
        }))
    ),
    ...(
        [
            { status: 'awaiting_approval', approval_state: 'pending' },
            { status: 'approved', approval_state: 'approved' },
            { status: 'rejected', approval_state: 'rejected' },
            { status: 'cancelled', error_message: 'Cancelled' },
        ] as const
    ).map((patch) => ({
        kind: 'builtin' as const,
        patch,
        apply: (id: number) => updateBuiltInToolLogById(id, patch),
    })),
];

describe('given calls reuse a provider call ID across messages and sessions', () => {
    afterEach(closeTestDatabases);

    it.each(scenarios)(
        'user receives $patch.status for the current $kind call and keeps earlier results and summaries unchanged',
        async ({ kind, patch, apply }) => {
            const database = openMigratedDatabase();
            routeQueriesTo(database);
            database.exec(`
                    INSERT INTO sessions (id, session_id, title, model) VALUES
                        (1, 'active', 'Active', 'test'), (2, 'other', 'Other', 'test');
                    INSERT INTO messages (id, session_id, role) VALUES
                        (1, 1, 'tool_call'), (2, 1, 'assistant'),
                        (3, 1, 'tool_call'), (4, 2, 'tool_call');
                `);
            const logs = [];
            for (const messageId of [1, 3, 4]) {
                logs.push(
                    await createToolPart(kind, {
                        message_id: messageId,
                        tool_call_id: 'reused-id',
                        ...(kind === 'builtin'
                            ? { tool_id: 'read' }
                            : { server_id: null, tool_name: 'read' }),
                        input: '{}',
                        output: `Result for message ${messageId}`,
                        status: 'success',
                    })
                );
            }
            database.exec(`
                    INSERT INTO message_parts (message_id, type, content, data, sort_order)
                    VALUES (2, 'context_compaction', 'Earlier result',
                        '{"version":2,"firstKeptMessageId":2}', 0);
                `);
            const summary = () =>
                database
                    .prepare("SELECT * FROM message_parts WHERE type = 'context_compaction'")
                    .get();
            const originalSummary = summary();
            const [archived, current, otherSession] = logs;

            await apply(current!.id);

            expect(await findToolPartById(kind, archived!.id)).toEqual(archived);
            expect(await findToolPartById(kind, otherSession!.id)).toEqual(otherSession);
            expect(await findToolPartById(kind, current!.id)).toMatchObject(patch);
            expect(summary()).toEqual(originalSummary);
        }
    );
});
