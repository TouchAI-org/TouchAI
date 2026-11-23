import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '@tests/database/sqliteHarness';
import { afterEach, describe, expect, it } from 'vitest';

import {
    findConversationSearchMatchMessages,
    findConversationSearchMessagesBySessionIds,
} from '@/database/queries/messages';
import { listSessions } from '@/database/queries/sessions';

afterEach(closeTestDatabases);

describe('given conversation search exposes its database access path', () => {
    it('user gets FTS candidate filtering plus the existing session and message indexes without a new index', async () => {
        const database = openMigratedDatabase();
        let searchRequest:
            | {
                  sql: string;
                  params: unknown[];
              }
            | undefined;
        let messageRequest:
            | {
                  sql: string;
                  params: unknown[];
              }
            | undefined;
        let matchRequest:
            | {
                  sql: string;
                  params: unknown[];
              }
            | undefined;
        routeQueriesTo(database, {
            afterQuery(request) {
                if (request.sql.includes('message_search_fts')) {
                    searchRequest = {
                        sql: request.sql,
                        params: request.params,
                    };
                }
                if (request.sql.includes('json_group_array')) {
                    messageRequest = {
                        sql: request.sql,
                        params: request.params,
                    };
                }
                if (request.sql.includes('instr(lower(content)')) {
                    matchRequest = {
                        sql: request.sql,
                        params: request.params,
                    };
                }
            },
        });

        await listSessions({
            query: 'abcdefghi',
            limit: 100,
            fromDate: '2026-01-01',
            toDate: '2026-01-31',
            model: 'model-a',
            roles: ['user', 'assistant'],
            textContentOnly: true,
        });

        expect(searchRequest).toBeDefined();
        const plan = database
            .prepare(`EXPLAIN QUERY PLAN ${searchRequest!.sql}`)
            .all(...(searchRequest!.params as [])) as Array<{ detail: string }>;
        const details = plan.map((row) => row.detail).join('\n');

        expect(details).toContain('SCAN sessions USING INDEX sessions_activity_idx');
        expect(details).toContain('SCAN message_search_fts VIRTUAL TABLE INDEX');
        expect(details).toContain(
            'SEARCH message_parts USING INDEX message_parts_message_id_sort_order_idx'
        );
        expect(details).toContain(
            'SEARCH latest_session_turns USING INDEX session_turns_session_created_idx'
        );

        database.exec(
            `INSERT INTO sessions (id, session_id, title, model)
             VALUES (1, 'session-1', 'Session', 'model-a');
             INSERT INTO messages (id, session_id, role)
             VALUES (1, 1, 'user')`
        );
        await findConversationSearchMessagesBySessionIds([1], ['user']);
        expect(messageRequest).toBeDefined();
        const messagePlan = database
            .prepare(`EXPLAIN QUERY PLAN ${messageRequest!.sql}`)
            .all(...(messageRequest!.params as [])) as Array<{ detail: string }>;
        const messageDetails = messagePlan.map((row) => row.detail).join('\n');

        expect(messageDetails).toContain('SEARCH messages USING INDEX messages_session_id_id_idx');
        expect(messageDetails).not.toMatch(/^SCAN messages\b/m);
        expect(messageDetails).toContain(
            'SEARCH message_parts USING INDEX message_parts_message_id_sort_order_idx'
        );

        await findConversationSearchMatchMessages([1], ['user'], 'abcdefghi', 3);
        expect(matchRequest).toBeDefined();
        const matchPlan = database
            .prepare(`EXPLAIN QUERY PLAN ${matchRequest!.sql}`)
            .all(...(matchRequest!.params as [])) as Array<{ detail: string }>;
        const matchDetails = matchPlan.map((row) => row.detail).join('\n');

        expect(matchDetails).toContain('SCAN message_search_fts VIRTUAL TABLE INDEX');
        expect(matchDetails).toContain('SEARCH messages USING INTEGER PRIMARY KEY');
        expect(matchDetails).not.toMatch(/^SCAN messages\b/m);
    });
});
