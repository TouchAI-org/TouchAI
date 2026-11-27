import { listSessions, refreshSessionMetadata } from '@database/queries/sessions';
import type { InvokeArgs } from '@tauri-apps/api/core';
import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '@tests/database/sqliteHarness';
import { getTauriInvokeCalls, interceptTauriInvoke } from '@tests/utils/tauri';
import { afterEach, describe, expect, it } from 'vitest';

afterEach(closeTestDatabases);

function getRequest(payload: InvokeArgs | undefined) {
    return (payload as { request?: { sql: string; params?: unknown[]; method: string } })?.request;
}

describe('when a conversation records its model', () => {
    it('user keeps the provider they picked before the first message is sent', async () => {
        interceptTauriInvoke((call) => {
            if (call.cmd === 'database_query') {
                return { rows: [], rowsAffected: 1, lastInsertId: null };
            }

            return undefined;
        });

        await expect(refreshSessionMetadata(17)).resolves.toBeUndefined();

        const request = getTauriInvokeCalls('database_query')
            .map((call) => getRequest(call.payload))
            .find((candidate) => candidate?.method === 'run');
        const normalizedSql = request?.sql.replace(/\s+/g, ' ').trim().toLowerCase() ?? '';

        expect(normalizedSql).toContain('"provider_id" = coalesce((');
        expect(normalizedSql).toContain('from "session_turns" "latest_turns"');
        expect(normalizedSql).toContain('"sessions"."provider_id"');
        expect(normalizedSql).not.toContain('"provider_id" = (select');
    });

    it('narrows session content search with multiple necessary trigrams', async () => {
        interceptTauriInvoke((call) => {
            if (call.cmd === 'database_query') {
                return { rows: [], rowsAffected: 0, lastInsertId: null };
            }

            return undefined;
        });

        await listSessions({ query: 'abcdefghi', limit: 40 });

        const searchRequest = getTauriInvokeCalls('database_query')
            .map((call) => getRequest(call.payload))
            .find((candidate) => candidate?.sql.includes('message_search_fts'));

        expect(searchRequest).toBeDefined();
        expect(searchRequest!.params).toContain('"abc" AND "def" AND "ghi"');
    });
});

function seedSession(
    database: ReturnType<typeof openMigratedDatabase>,
    input: {
        id: number;
        title: string;
        model: string;
        createdAt: string;
        preview?: string | null;
        archivedAt?: string | null;
    }
) {
    database
        .prepare(
            `INSERT INTO sessions (
                id, session_id, title, model, last_message_preview, archived_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
            input.id,
            `session-${input.id}`,
            input.title,
            input.model,
            input.preview ?? null,
            input.archivedAt ?? null,
            input.createdAt,
            input.createdAt
        );
}

function seedMessage(
    database: ReturnType<typeof openMigratedDatabase>,
    input: {
        id: number;
        sessionId: number;
        role: 'user' | 'assistant' | 'system' | 'tool_call';
        content: string;
    }
) {
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

function sqliteUtc(date: Date): string {
    return date.toISOString().slice(0, 19).replace('T', ' ');
}

function localDayStart(dateOnly: string): Date {
    const [year, month, day] = dateOnly.split('-').map(Number);
    const value = new Date(0);
    value.setHours(0, 0, 0, 0);
    value.setFullYear(year!, month! - 1, day!);
    return value;
}

describe('given conversation search needs structured candidate filters', () => {
    it('user keeps a title match when a role filter excludes every message', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seedSession(database, {
            id: 1,
            title: 'Release checklist',
            model: 'model-a',
            createdAt: '2026-01-01 00:00:00',
        });
        seedMessage(database, {
            id: 1,
            sessionId: 1,
            role: 'assistant',
            content: 'Only the assistant discusses this topic.',
        });

        const sessions = await listSessions({
            query: 'release',
            roles: ['user'],
        });

        expect(sessions.map((session) => session.id)).toEqual([1]);
    });

    it('user applies role filters only to message content and never searches the session preview', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seedSession(database, {
            id: 1,
            title: 'User topic',
            model: 'model-a',
            createdAt: '2026-01-03 00:00:00',
        });
        seedMessage(database, {
            id: 1,
            sessionId: 1,
            role: 'user',
            content: 'needle in a user message',
        });
        seedMessage(database, {
            id: 2,
            sessionId: 1,
            role: 'assistant',
            content: 'needle in an assistant message',
        });
        seedSession(database, {
            id: 2,
            title: 'Preview only',
            model: 'model-a',
            createdAt: '2026-01-02 00:00:00',
            preview: 'needle exists only in the preview',
        });

        const assistantMatches = await listSessions({
            query: 'needle',
            roles: ['assistant'],
        });
        const userMatches = await listSessions({
            query: 'needle',
            roles: ['user'],
        });

        expect(assistantMatches.map((session) => session.id)).toEqual([1]);
        expect(userMatches.map((session) => session.id)).toEqual([1]);
    });

    it('user searches only user and assistant text while tool output keeps its existing session-search behavior', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seedSession(database, {
            id: 1,
            title: 'Assistant answer',
            model: 'model-a',
            createdAt: '2026-01-03 00:00:00',
        });
        seedMessage(database, {
            id: 1,
            sessionId: 1,
            role: 'assistant',
            content: 'A visible assistant answer',
        });
        database
            .prepare(
                `INSERT INTO message_parts (message_id, type, content, data, sort_order)
                 VALUES (1, 'tool_call', '', '{"output":"secret tool output"}', 1)`
            )
            .run();

        const existingSearch = await listSessions({
            query: 'secret',
            roles: ['assistant'],
        });
        const conversationSearch = await listSessions({
            query: 'secret',
            roles: ['assistant'],
            textContentOnly: true,
        });

        expect(existingSearch.map((session) => session.id)).toEqual([1]);
        expect(conversationSearch).toEqual([]);
    });

    it('user includes archived sessions and filters by model and created date boundaries', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seedSession(database, {
            id: 1,
            title: 'Archived target',
            model: 'model-a',
            createdAt: '2026-01-01 00:00:00',
            archivedAt: '2026-02-01 00:00:00',
        });
        seedSession(database, {
            id: 2,
            title: 'Different model',
            model: 'model-b',
            createdAt: '2026-01-01 12:00:00',
        });
        seedSession(database, {
            id: 3,
            title: 'After range',
            model: 'model-a',
            createdAt: '2026-01-02 00:00:00',
        });

        const sessions = await listSessions({
            query: 'archived',
            roles: ['user', 'assistant'],
            model: 'MODEL-A',
            fromDate: '2026-01-01',
            toDate: '2026-01-01',
        });

        expect(sessions.map((session) => session.id)).toEqual([1]);
    });

    it('user includes both local calendar-day boundaries when filtering date-only ranges', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        const dayStart = localDayStart('2026-03-01');
        const nextDayStart = localDayStart('2026-03-02');
        seedSession(database, {
            id: 1,
            title: 'Boundary before',
            model: 'model-a',
            createdAt: sqliteUtc(new Date(dayStart.getTime() - 1_000)),
        });
        seedSession(database, {
            id: 2,
            title: 'Boundary start',
            model: 'model-a',
            createdAt: sqliteUtc(dayStart),
        });
        seedSession(database, {
            id: 3,
            title: 'Boundary end',
            model: 'model-a',
            createdAt: sqliteUtc(new Date(nextDayStart.getTime() - 1_000)),
        });
        seedSession(database, {
            id: 4,
            title: 'Boundary after',
            model: 'model-a',
            createdAt: sqliteUtc(nextDayStart),
        });

        const sessions = await listSessions({
            query: 'boundary',
            fromDate: '2026-03-01',
            toDate: '2026-03-01',
        });

        expect(sessions.map((session) => session.id).sort()).toEqual([2, 3]);
    });

    it('user can combine a same-day timestamp lower bound with an inclusive date-only upper bound', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        const dayStart = localDayStart('2026-03-01');
        seedSession(database, {
            id: 1,
            title: 'Outside lower bound',
            model: 'model-a',
            createdAt: sqliteUtc(new Date(dayStart.getTime() + 1_000)),
        });
        seedSession(database, {
            id: 2,
            title: 'Inside lower bound',
            model: 'model-a',
            createdAt: sqliteUtc(new Date(dayStart.getTime() + 13 * 60 * 60 * 1_000)),
        });

        const sessions = await listSessions({
            query: 'lower bound',
            fromDate: new Date(dayStart.getTime() + 12 * 60 * 60 * 1_000).toISOString(),
            toDate: '2026-03-01',
        });

        expect(sessions.map((session) => session.id)).toEqual([2]);
    });

    it('user sees actionable date errors before a malformed range reaches the database', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);

        await expect(
            listSessions({ query: 'anything', fromDate: '2026-01-02', toDate: '2026-01-01' })
        ).rejects.toThrow('from_date must not be later than to_date');
        await expect(listSessions({ query: 'anything', fromDate: '2026-02-30' })).rejects.toThrow(
            'from_date must be a valid local date'
        );
    });

    it('user searches literal CJK, emoji, percent, underscore, and backslash text', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        const query = '会话100%_\\🙂';
        seedSession(database, {
            id: 1,
            title: 'Special query',
            model: 'model-a',
            createdAt: '2026-01-01 00:00:00',
        });
        seedMessage(database, {
            id: 1,
            sessionId: 1,
            role: 'user',
            content: `${query} appears literally`,
        });

        const sessions = await listSessions({
            query,
            roles: ['user', 'assistant'],
        });

        expect(sessions.map((session) => session.id)).toEqual([1]);
    });
});
