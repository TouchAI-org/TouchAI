import type { SQLInputValue } from 'node:sqlite';

import {
    findAttachmentRemoteRef,
    touchAttachmentRemoteRefLastUsed,
    upsertAttachmentRemoteRef,
} from '@database/queries/attachmentRemoteRefs';
import { interceptTauriInvoke } from '@tests/utils/tauri';
import { afterEach, describe, expect, it } from 'vitest';

import { openMigratedDatabase } from './sqliteHarness';

/**
 * A remote reference is a provider-side handle for an attachment that has already been uploaded.
 * Reusing it saves a second upload of the same bytes; keeping a stale one uploads nothing and
 * sends the model a dead handle.
 */
const databases: ReturnType<typeof openMigratedDatabase>[] = [];

function openDatabase() {
    const database = openMigratedDatabase();
    databases.push(database);
    return database;
}

function routeQueriesTo(database: ReturnType<typeof openMigratedDatabase>) {
    interceptTauriInvoke((call) => {
        if (call.cmd === 'database_tx_begin') {
            database.exec('BEGIN');
            return 'test-tx';
        }
        if (call.cmd === 'database_tx_commit') {
            database.exec('COMMIT');
            return null;
        }
        if (call.cmd === 'database_tx_rollback') {
            database.exec('ROLLBACK');
            return null;
        }
        if (call.cmd !== 'database_query' && call.cmd !== 'database_tx_query') return undefined;
        const { request } = call.payload as {
            request: { sql: string; params: SQLInputValue[]; method: string };
        };
        const statement = database.prepare(request.sql);
        if (request.method === 'run') {
            const result = statement.run(...request.params);
            return {
                rows: [],
                rowsAffected: Number(result.changes),
                lastInsertId: Number(result.lastInsertRowid),
            };
        }
        return { rows: statement.all(...request.params), rowsAffected: 0, lastInsertId: null };
    });
}

function seedAttachment(database: ReturnType<typeof openMigratedDatabase>) {
    database.exec(`
        INSERT INTO sessions (id, session_id, title, model) VALUES (1, 's1', 'Conversation', 'test');
        INSERT INTO messages (id, session_id, role) VALUES (1, 1, 'user');
        INSERT INTO attachments (id, hash, type, original_name, origin_path)
            VALUES (1, 'hash-a', 'image', 'photo.png', '/pictures/photo.png');
        INSERT INTO providers (id, name, driver, api_endpoint, logo, enabled, is_builtin)
            VALUES (2, 'OpenAI', 'openai', 'https://api.example.com', '', 1, 1),
                   (3, 'Anthropic', 'anthropic', 'https://api.example.com', '', 1, 1);
    `);
}

afterEach(() => {
    databases.splice(0).forEach((database) => database.close());
});

describe('user sends an attachment to a provider twice', () => {
    it('user gets the stored remote reference reused on the second send', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seedAttachment(database);

        await upsertAttachmentRemoteRef({
            attachment_id: 1,
            provider_id: 2,
            transport_kind: 'openai-file-id',
            remote_ref: 'file-abc',
            mime_type: 'image/png',
        });

        const found = await findAttachmentRemoteRef({
            attachmentId: 1,
            providerId: 2,
            transportKind: 'openai-file-id',
        });

        // Reusing the handle is the whole point: a second upload wastes the user's quota.
        expect(found).toMatchObject({ remote_ref: 'file-abc', mime_type: 'image/png' });
    });

    it('user gets a newer reference replacing the one already stored', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seedAttachment(database);

        await upsertAttachmentRemoteRef({
            attachment_id: 1,
            provider_id: 2,
            transport_kind: 'openai-file-id',
            remote_ref: 'file-old',
        });
        await upsertAttachmentRemoteRef({
            attachment_id: 1,
            provider_id: 2,
            transport_kind: 'openai-file-id',
            remote_ref: 'file-new',
        });

        const found = await findAttachmentRemoteRef({
            attachmentId: 1,
            providerId: 2,
            transportKind: 'openai-file-id',
        });

        // A stale handle points at a deleted file; only one row may exist per key.
        expect(found?.remote_ref).toBe('file-new');
        const rows = database.prepare('SELECT COUNT(*) AS n FROM attachment_remote_refs').get() as {
            n: number;
        };
        expect(rows.n).toBe(1);
    });

    it('user gets no reference for a provider that never received the file', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seedAttachment(database);

        await upsertAttachmentRemoteRef({
            attachment_id: 1,
            provider_id: 2,
            transport_kind: 'openai-file-id',
            remote_ref: 'file-abc',
        });

        // Another provider has its own namespace; the handle must not leak across.
        await expect(
            findAttachmentRemoteRef({
                attachmentId: 1,
                providerId: 3,
                transportKind: 'openai-file-id',
            })
        ).resolves.toBeNull();
    });

    it('user gets separate references for each transport on the same provider', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seedAttachment(database);

        await upsertAttachmentRemoteRef({
            attachment_id: 1,
            provider_id: 2,
            transport_kind: 'openai-file-id',
            remote_ref: 'file-abc',
        });
        await upsertAttachmentRemoteRef({
            attachment_id: 1,
            provider_id: 2,
            transport_kind: 'url',
            remote_ref: 'https://cdn.example/photo.png',
        });

        const byFileId = await findAttachmentRemoteRef({
            attachmentId: 1,
            providerId: 2,
            transportKind: 'openai-file-id',
        });
        const byUrl = await findAttachmentRemoteRef({
            attachmentId: 1,
            providerId: 2,
            transportKind: 'url',
        });

        expect(byFileId?.remote_ref).toBe('file-abc');
        expect(byUrl?.remote_ref).toBe('https://cdn.example/photo.png');
    });

    it('user gets the expiry kept so an expired handle is not reused forever', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seedAttachment(database);
        const expiresAt = '2026-12-31T00:00:00Z';

        await upsertAttachmentRemoteRef({
            attachment_id: 1,
            provider_id: 2,
            transport_kind: 'url',
            remote_ref: 'https://cdn.example/photo.png',
            expires_at: expiresAt,
        });

        const found = await findAttachmentRemoteRef({
            attachmentId: 1,
            providerId: 2,
            transportKind: 'url',
        });

        expect(found?.expires_at).toBe(expiresAt);
    });
});

describe('user gets the reference timestamped without supplying one', () => {
    it('user gets the creation time filled in for them', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seedAttachment(database);

        const created = await upsertAttachmentRemoteRef({
            attachment_id: 1,
            provider_id: 2,
            transport_kind: 'openai-file-id',
            remote_ref: 'file-abc',
        });

        // The caller should not have to invent a timestamp to store a handle.
        expect(created.created_at).toBeTruthy();
        expect(created.updated_at).toBe(created.created_at);
        expect(created.last_used_at).toBe(created.created_at);
    });

    it('user gets the times they supplied kept as given', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seedAttachment(database);

        const created = await upsertAttachmentRemoteRef({
            attachment_id: 1,
            provider_id: 2,
            transport_kind: 'openai-file-id',
            remote_ref: 'file-abc',
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-02-01T00:00:00Z',
            last_used_at: '2026-03-01T00:00:00Z',
        });

        expect(created.created_at).toBe('2026-01-01T00:00:00Z');
        expect(created.updated_at).toBe('2026-02-01T00:00:00Z');
        expect(created.last_used_at).toBe('2026-03-01T00:00:00Z');
    });
});

describe('user reuses a reference', () => {
    it('user gets the last-used time moved forward so eviction keeps the live ones', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seedAttachment(database);
        await upsertAttachmentRemoteRef({
            attachment_id: 1,
            provider_id: 2,
            transport_kind: 'openai-file-id',
            remote_ref: 'file-abc',
            last_used_at: '2026-01-01T00:00:00Z',
        });

        const stored = await findAttachmentRemoteRef({
            attachmentId: 1,
            providerId: 2,
            transportKind: 'openai-file-id',
        });
        await touchAttachmentRemoteRefLastUsed({
            id: stored!.id,
            lastUsedAt: '2026-06-01T00:00:00Z',
        });

        const found = await findAttachmentRemoteRef({
            attachmentId: 1,
            providerId: 2,
            transportKind: 'openai-file-id',
        });
        // Eviction order is by least-recently-used, so a reuse has to move the row.
        expect(found?.last_used_at).toBe('2026-06-01T00:00:00Z');
    });

    it('user gets the reference untouched when touching a row that is not there', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seedAttachment(database);

        // Touching an unknown id must be a no-op, not an insert of a half-built row.
        await touchAttachmentRemoteRefLastUsed({ id: 999, lastUsedAt: '2026-06-01T00:00:00Z' });

        const rows = database.prepare('SELECT COUNT(*) AS n FROM attachment_remote_refs').get() as {
            n: number;
        };
        expect(rows.n).toBe(0);
    });
});
