import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '@tests/database/sqliteHarness';
import { afterEach, describe, expect, it } from 'vitest';

import { findConversationSearchMessagesBySessionIds } from '@/database/queries/messages';
import { CONVERSATION_SEARCH_MATCH_MAX_CANDIDATES } from '@/modules/tools/builtin/search-conversation/constants';
import { databaseSearchConversationHistory } from '@/modules/tools/builtin/search-conversation/operations.io';

afterEach(closeTestDatabases);

function seedSession(database: ReturnType<typeof openMigratedDatabase>, id: number): void {
    database
        .prepare(
            `INSERT INTO sessions (id, session_id, title, model, created_at, updated_at)
             VALUES (?, ?, ?, 'model-a', '2026-01-01 00:00:00', '2026-01-01 00:00:00')`
        )
        .run(id, `session-${id}`, `Session ${id}`);
}

function seedMessage(
    database: ReturnType<typeof openMigratedDatabase>,
    input: {
        id: number;
        sessionId: number;
        role: 'user' | 'assistant' | 'system' | 'tool_call';
        content: string;
    }
): void {
    database
        .prepare(
            `INSERT INTO messages (id, session_id, role, created_at, updated_at)
             VALUES (?, ?, ?, '2026-01-01 00:00:00', '2026-01-01 00:00:00')`
        )
        .run(input.id, input.sessionId, input.role);
    database
        .prepare(
            `INSERT INTO message_parts (message_id, type, content, data, sort_order)
             VALUES (?, 'text', ?, '{}', 0)`
        )
        .run(input.id, input.content);
}

describe('given conversation search needs bounded transcript messages for many sessions', () => {
    it('user receives only the first and last fifty eligible messages and never system or tool content', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seedSession(database, 1);
        seedSession(database, 2);
        for (let id = 1; id <= 120; id += 1) {
            seedMessage(database, {
                id,
                sessionId: 1,
                role: id % 2 === 0 ? 'assistant' : 'user',
                content: `eligible-${id}`,
            });
        }
        seedMessage(database, {
            id: 121,
            sessionId: 1,
            role: 'system',
            content: 'system-secret',
        });
        seedMessage(database, {
            id: 122,
            sessionId: 1,
            role: 'tool_call',
            content: 'tool-secret',
        });
        seedMessage(database, {
            id: 200,
            sessionId: 2,
            role: 'assistant',
            content: 'other-session',
        });

        const rows = await findConversationSearchMessagesBySessionIds([1], ['user', 'assistant']);

        expect(rows.map((row) => row.id)).toEqual([
            ...Array.from({ length: 50 }, (_, index) => index + 1),
            ...Array.from({ length: 50 }, (_, index) => index + 71),
        ]);
        expect(rows.every((row) => row.role === 'user' || row.role === 'assistant')).toBe(true);
        expect(rows.map((row) => row.content).join('\n')).not.toContain('system-secret');
        expect(rows.map((row) => row.content).join('\n')).not.toContain('tool-secret');
        expect(rows.map((row) => row.content).join('\n')).not.toContain('other-session');
    });

    it('user receives role-filtered messages in one bounded batch for all candidate sessions', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seedSession(database, 1);
        seedSession(database, 2);
        seedMessage(database, {
            id: 1,
            sessionId: 1,
            role: 'user',
            content: 'user-only-1',
        });
        seedMessage(database, {
            id: 2,
            sessionId: 1,
            role: 'assistant',
            content: 'assistant-only-1',
        });
        seedMessage(database, {
            id: 3,
            sessionId: 2,
            role: 'user',
            content: 'user-only-2',
        });
        seedMessage(database, {
            id: 4,
            sessionId: 2,
            role: 'assistant',
            content: 'assistant-only-2',
        });

        const rows = await findConversationSearchMessagesBySessionIds([1, 2], ['assistant']);

        expect(rows).toEqual([
            {
                id: 2,
                session_id: 1,
                role: 'assistant',
                content: 'assistant-only-1',
            },
            {
                id: 4,
                session_id: 2,
                role: 'assistant',
                content: 'assistant-only-2',
            },
        ]);
    });

    it('user receives only text parts when an eligible message also contains tool output', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seedSession(database, 1);
        seedMessage(database, {
            id: 1,
            sessionId: 1,
            role: 'assistant',
            content: 'visible answer',
        });
        database
            .prepare(
                `INSERT INTO message_parts (message_id, type, content, data, sort_order)
                 VALUES (1, 'tool_call', '', '{"output":"hidden tool output"}', 1)`
            )
            .run();

        const rows = await findConversationSearchMessagesBySessionIds([1], ['assistant']);

        expect(rows).toEqual([
            {
                id: 1,
                session_id: 1,
                role: 'assistant',
                content: 'visible answer',
            },
        ]);
        expect(JSON.stringify(rows)).not.toContain('hidden tool output');
    });

    it('user gets a match anchor for a hit in the middle of a long conversation', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seedSession(database, 1);
        for (let id = 1; id <= 120; id += 1) {
            seedMessage(database, {
                id,
                sessionId: 1,
                role: id % 2 === 0 ? 'assistant' : 'user',
                content: id === 61 ? 'needle in the middle of a long conversation' : `filler-${id}`,
            });
        }
        seedMessage(database, { id: 121, sessionId: 1, role: 'system', content: 'needle hidden' });

        const rows = await databaseSearchConversationHistory.findMatchMessages(
            [1],
            ['user', 'assistant'],
            'needle',
            3
        );

        expect(rows).toEqual([
            {
                id: 61,
                session_id: 1,
                role: 'user',
                content: 'needle in the middle of a long conversation',
            },
        ]);
    });

    it('user gets an anchor when only the case differs outside ASCII', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seedSession(database, 1);
        seedMessage(database, {
            id: 1,
            sessionId: 1,
            role: 'user',
            content: 'ÉTÉ echoes',
        });

        const rows = await databaseSearchConversationHistory.findMatchMessages(
            [1],
            ['user', 'assistant'],
            'été',
            3
        );

        expect(rows).toEqual([
            {
                id: 1,
                session_id: 1,
                role: 'user',
                content: 'ÉTÉ echoes',
            },
        ]);
    });

    it('user still gets an earlier anchor after newer matches clean to empty snippets', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seedSession(database, 1);
        seedMessage(database, {
            id: 1,
            sessionId: 1,
            role: 'user',
            content: 'visible needle',
        });
        for (let id = 2; id <= 4; id += 1) {
            seedMessage(database, {
                id,
                sessionId: 1,
                role: 'assistant',
                content: `<system-reminder>needle ${id}</system-reminder>`,
            });
        }

        const rows = await databaseSearchConversationHistory.findMatchMessages(
            [1],
            ['user', 'assistant'],
            'needle',
            3
        );

        expect(rows.map((row) => row.id)).toContain(1);
    });

    it('user gets the valid anchor when newer trigram false positives fill a page', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seedSession(database, 1);
        seedMessage(database, {
            id: 1,
            sessionId: 1,
            role: 'user',
            content: 'valid abcdefghi anchor',
        });
        for (let id = 2; id <= 31; id += 1) {
            seedMessage(database, {
                id,
                sessionId: 1,
                role: 'assistant',
                content: `abc def ghi ${id}`,
            });
        }

        const rows = await databaseSearchConversationHistory.findMatchMessages(
            [1],
            ['user', 'assistant'],
            'abcdefghi',
            3
        );

        expect(rows.map((row) => row.id)).toEqual([1]);
    });

    it('user pages past accented trigram false positives to the real anchor', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seedSession(database, 1);
        seedMessage(database, {
            id: 1,
            sessionId: 1,
            role: 'user',
            content: 'valid éééé anchor',
        });
        for (let id = 2; id <= 151; id += 1) {
            seedMessage(database, {
                id,
                sessionId: 1,
                role: 'assistant',
                content: `ééé placeholder ${id}`,
            });
        }

        const rows = await databaseSearchConversationHistory.findMatchMessages(
            [1],
            ['user', 'assistant'],
            'éééé',
            3
        );

        expect(rows.map((row) => row.id)).toEqual([1]);
    });

    it('user gets an earlier session anchor after a later session fills the candidate budget', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seedSession(database, 1);
        seedSession(database, 2);
        seedMessage(database, {
            id: 1,
            sessionId: 1,
            role: 'user',
            content: 'valid needle anchor',
        });
        for (let index = 0; index < CONVERSATION_SEARCH_MATCH_MAX_CANDIDATES; index += 1) {
            seedMessage(database, {
                id: index + 2,
                sessionId: 2,
                role: 'assistant',
                content: `valid needle ${index}`,
            });
        }

        const rows = await databaseSearchConversationHistory.findMatchMessages(
            [1, 2],
            ['user', 'assistant'],
            'needle',
            3
        );

        expect(rows.filter((row) => row.session_id === 1).map((row) => row.id)).toEqual([1]);
        expect(rows.filter((row) => row.session_id === 2)).toHaveLength(3);
    });

    it('user gets an anchor when casing differs through a non-ASCII fold to ASCII', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seedSession(database, 1);
        seedMessage(database, {
            id: 1,
            sessionId: 1,
            role: 'user',
            content: 'Kelvin temperature',
        });

        const rows = await databaseSearchConversationHistory.findMatchMessages(
            [1],
            ['user', 'assistant'],
            'kelvin',
            3
        );

        expect(rows).toEqual([
            {
                id: 1,
                session_id: 1,
                role: 'user',
                content: 'Kelvin temperature',
            },
        ]);
    });
});
