import { getTauriInvokeCalls, mockTauriCommand } from '@tests/utils/tauri';
import { beforeEach, describe, expect, it } from 'vitest';

import { searchConversationSessions } from '@/database/queries/searchConversation';

const sessionRow = {
    id: 1,
    session_id: 'session-1',
    title: 'Memory design',
    model: 'gpt-5.5',
    provider_id: 1,
    last_message_preview: 'Discussed desktop Agent memory and clipboard workflows.',
    last_message_at: '2026-05-22T01:00:00.000Z',
    message_count: 6,
    status_badge_dismissed_turn_id: null,
    pending_terminal_status: null,
    pinned_at: null,
    archived_at: null,
    created_at: '2026-05-22T00:00:00.000Z',
    updated_at: '2026-05-22T01:00:00.000Z',
};

beforeEach(() => {
    mockTauriCommand('database_query', {
        rows: [sessionRow],
        rowsAffected: 1,
        lastInsertId: null,
    });
});

function getLastDatabaseRequest() {
    const calls = getTauriInvokeCalls('database_query');
    return calls[calls.length - 1]?.payload as
        | { request: { sql: string; params?: unknown[]; method: string } }
        | undefined;
}

describe('searchConversationSessions', () => {
    it('searches across multiple keywords with any mode by default', async () => {
        const rows = await searchConversationSessions({
            keywords: ['memory', 'clipboard'],
            limit: 10,
        });

        expect(rows).toEqual([sessionRow]);
        const request = getLastDatabaseRequest()?.request;
        expect(request?.sql).toContain('from "sessions"');
        expect(request?.sql).toContain('"sessions"."last_message_preview"');
        expect(request?.sql).toContain('exists');
        expect(request?.params).toContain('%memory%');
        expect(request?.params).toContain('%clipboard%');
    });

    it('supports all keyword mode and structured filters', async () => {
        await searchConversationSessions({
            query: 'desktop',
            keywords: ['memory', 'Agent'],
            keywordMode: 'all',
            fromDate: '2026-05-01',
            toDate: '2026-05-31',
            model: 'gpt-5.5',
            role: 'user',
            limit: 5,
        });

        const request = getLastDatabaseRequest()?.request;
        expect(request?.sql).toContain('"sessions"."created_at" >= ?');
        expect(request?.sql).toContain('"sessions"."created_at" <= ?');
        expect(request?.sql).toContain('"sessions"."model" = ?');
        expect(request?.sql).toContain('"searchable_messages"."role" = ?');
        expect(request?.sql).not.toContain('lower("sessions"."title") LIKE');
        expect(request?.sql).not.toContain('lower("sessions"."last_message_preview") LIKE');
        expect(request?.params).toContain('user');
        expect(request?.params).toContain('gpt-5.5');
    });

    it('keeps structured filters as narrowing conditions when keyword mode is any', async () => {
        await searchConversationSessions({
            keywords: ['memory', 'clipboard'],
            keywordMode: 'any',
            fromDate: '2026-05-01',
            model: 'gpt-5.5',
        });

        const request = getLastDatabaseRequest()?.request;
        expect(request?.sql).toMatch(/\)\s+and\s+"sessions"\."created_at" >= \?/i);
        expect(request?.sql).toMatch(
            /"sessions"\."created_at" >= \?\s+and\s+"sessions"\."model" = \?/i
        );
    });

    it('redacts secret-like search terms before they reach database query params', async () => {
        const githubToken = 'ghp_1234567890abcdefghijklmnopqrstuvwxyzAB';

        await searchConversationSessions({
            query: githubToken,
            keywords: ['clipboard'],
        });

        const request = getLastDatabaseRequest()?.request;
        const serializedParams = JSON.stringify(request?.params ?? []);
        expect(serializedParams).not.toContain(githubToken);
        expect(serializedParams.toLocaleLowerCase()).toContain('redacted');
        expect(serializedParams.toLocaleLowerCase()).toContain('secret');
        expect(serializedParams.toLocaleLowerCase()).toContain('content');
        expect(request?.params).toContain('%clipboard%');
    });
});
