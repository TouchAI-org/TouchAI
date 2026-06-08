import type { InvokeArgs } from '@tauri-apps/api/core';
import { getTauriInvokeCalls, mockTauriCommand } from '@tests/utils/tauri';
import { beforeEach, describe, expect, it } from 'vitest';

import {
    createMemoryItem,
    deleteMemoryItem,
    disableMemoryItem,
    findEnabledMemoryDirectoryItems,
    findMemoryDirectoryItems,
    findMemoryItemByNormalizedTitle,
    readEnabledMemoryItemsByIds,
    readMemoryItemsByIds,
    touchMemoryItemsLastUsed,
    updateMemoryItem,
} from '@/database/queries/memoryItems';

function mockDatabaseRows(rows: Record<string, unknown>[]) {
    mockTauriCommand('database_query', (payload: InvokeArgs) => {
        const request = (payload as { request: { method: string } }).request;
        return {
            rows,
            rowsAffected: request.method === 'run' ? 1 : rows.length,
            lastInsertId: rows[0]?.id ?? null,
        };
    });
}

function getLastDatabaseRequest() {
    const calls = getTauriInvokeCalls('database_query');
    return calls[calls.length - 1]?.payload as
        | { request: { sql: string; params?: unknown[]; method: string } }
        | undefined;
}

const fullMemoryRow = {
    id: 7,
    title: 'Desktop workflow',
    applicability: 'Read when files, clipboard, screenshots, or desktop workflows matter.',
    content: 'The user prefers explicit desktop-agent tool use for durable context.',
    enabled: 1,
    source_session_id: null,
    source_message_id: null,
    created_at: '2026-05-22T00:00:00.000Z',
    updated_at: '2026-05-22T00:00:00.000Z',
    last_used_at: null,
};

beforeEach(() => {
    mockDatabaseRows([]);
});

describe('memory item queries', () => {
    it('lists enabled memory directory rows without content', async () => {
        mockDatabaseRows([
            {
                id: 7,
                title: fullMemoryRow.title,
                applicability: fullMemoryRow.applicability,
                enabled: 1,
                updated_at: fullMemoryRow.updated_at,
            },
        ]);

        const rows = await findEnabledMemoryDirectoryItems();

        expect(rows).toEqual([
            {
                id: 7,
                title: fullMemoryRow.title,
                applicability: fullMemoryRow.applicability,
                enabled: 1,
                updated_at: fullMemoryRow.updated_at,
            },
        ]);
        const request = getLastDatabaseRequest()?.request;
        expect(request?.sql).toContain('from "memory_items"');
        expect(request?.sql).toContain('"memory_items"."enabled" = ?');
        expect(request?.sql).not.toContain('"content"');
    });

    it('lists all memory directory rows without content for settings management', async () => {
        mockDatabaseRows([
            {
                id: 7,
                title: fullMemoryRow.title,
                applicability: fullMemoryRow.applicability,
                enabled: 1,
                updated_at: fullMemoryRow.updated_at,
            },
            {
                id: 8,
                title: 'Disabled workflow',
                applicability: 'Visible in settings even while disabled.',
                enabled: 0,
                updated_at: '2026-05-21T00:00:00.000Z',
            },
        ]);

        const rows = await findMemoryDirectoryItems();

        expect(rows.map((row) => row.id)).toEqual([7, 8]);
        const request = getLastDatabaseRequest()?.request;
        expect(request?.sql).toContain('from "memory_items"');
        expect(request?.sql).not.toContain('"memory_items"."enabled" = ?');
        expect(request?.sql).not.toContain('"content"');
    });

    it('reads only valid enabled memory ids', async () => {
        mockDatabaseRows([fullMemoryRow]);

        const rows = await readEnabledMemoryItemsByIds([7, 7, 0, -1, 8.5, 9]);

        expect(rows).toHaveLength(1);
        expect(rows[0]?.id).toBe(7);
        const request = getLastDatabaseRequest()?.request;
        expect(request?.sql).toContain('from "memory_items"');
        expect(request?.sql).toContain('"memory_items"."enabled" = ?');
        expect(request?.params).toContain(7);
        expect(request?.params).toContain(9);
        expect(request?.params).not.toContain(0);
    });

    it('reads valid memory ids regardless of enabled state for settings management', async () => {
        mockDatabaseRows([fullMemoryRow, { ...fullMemoryRow, id: 8, enabled: 0 }]);

        const rows = await readMemoryItemsByIds([7, 8, 8, 0, -1, 2.5]);

        expect(rows.map((row) => row.id)).toEqual([7, 8]);
        const request = getLastDatabaseRequest()?.request;
        expect(request?.sql).toContain('from "memory_items"');
        expect(request?.sql).not.toContain('"memory_items"."enabled" = ?');
        expect(request?.params).toContain(7);
        expect(request?.params).toContain(8);
        expect(request?.params).not.toContain(0);
    });

    it('skips database access when reading no valid ids', async () => {
        await expect(readEnabledMemoryItemsByIds([0, -1, 2.5])).resolves.toEqual([]);

        expect(getTauriInvokeCalls('database_query')).toHaveLength(0);
    });

    it('skips database access when reading all memories with no valid ids', async () => {
        await expect(readMemoryItemsByIds([0, -1, 2.5])).resolves.toEqual([]);

        expect(getTauriInvokeCalls('database_query')).toHaveLength(0);
    });

    it('creates a memory item', async () => {
        mockDatabaseRows([fullMemoryRow]);

        const created = await createMemoryItem({
            title: 'Desktop workflow',
            applicability: fullMemoryRow.applicability,
            content: fullMemoryRow.content,
        });

        expect(created.id).toBe(7);
        const request = getLastDatabaseRequest()?.request;
        expect(request?.sql).toContain('insert into "memory_items"');
    });

    it('rejects secret-like content before creating memory items', async () => {
        await expect(
            createMemoryItem({
                title: 'API key',
                applicability: 'When calling services.',
                content: 'OPENAI_API_KEY=sk-test-secret-value',
            })
        ).rejects.toThrow(/secret-like content/);

        expect(getTauriInvokeCalls('database_query')).toHaveLength(0);
    });

    it('rejects blank required fields before creating memory items', async () => {
        await expect(
            createMemoryItem({
                title: '   ',
                applicability: fullMemoryRow.applicability,
                content: fullMemoryRow.content,
            })
        ).rejects.toThrow(/title/);

        expect(getTauriInvokeCalls('database_query')).toHaveLength(0);
    });

    it('updates a memory item and refreshes updated_at', async () => {
        mockDatabaseRows([{ ...fullMemoryRow, title: 'Updated' }]);

        const updated = await updateMemoryItem(7, {
            title: 'Updated',
            applicability: fullMemoryRow.applicability,
            content: fullMemoryRow.content,
        });

        expect(updated?.title).toBe('Updated');
        const request = getLastDatabaseRequest()?.request;
        expect(request?.sql).toContain('update "memory_items"');
        expect(request?.sql).toContain('"updated_at" = datetime(\'now\')');
    });

    it('rejects secret-like patch fields before updating memory items', async () => {
        await expect(
            updateMemoryItem(7, {
                applicability: 'PRIVATE_KEY=abc123',
            })
        ).rejects.toThrow(/secret-like content/);

        expect(getTauriInvokeCalls('database_query')).toHaveLength(0);
    });

    it('rejects blank patch fields before updating memory items', async () => {
        await expect(
            updateMemoryItem(7, {
                content: '',
            })
        ).rejects.toThrow(/content/);

        expect(getTauriInvokeCalls('database_query')).toHaveLength(0);
    });

    it('soft deletes an enabled memory by disabling it', async () => {
        mockDatabaseRows([{ ...fullMemoryRow, enabled: 0 }]);

        const disabled = await disableMemoryItem(7);

        expect(disabled?.id).toBe(7);
        const request = getLastDatabaseRequest()?.request;
        expect(request?.sql).toContain('update "memory_items"');
        expect(request?.sql).toContain('"enabled" = ?');
        expect(request?.sql).toContain('"memory_items"."enabled" = ?');
        expect(request?.params).toContain(0);
    });

    it('returns undefined when disabling a missing or already disabled memory', async () => {
        const disabled = await disableMemoryItem(404);

        expect(disabled).toBeUndefined();
        const request = getLastDatabaseRequest()?.request;
        expect(request?.sql).toContain('update "memory_items"');
        expect(request?.sql).toContain('"memory_items"."enabled" = ?');
    });

    it('deletes a memory item by id for manual settings removal', async () => {
        mockDatabaseRows([fullMemoryRow]);

        const deleted = await deleteMemoryItem(7);

        expect(deleted?.id).toBe(7);
        const request = getLastDatabaseRequest()?.request;
        expect(request?.sql).toContain('delete from "memory_items"');
        expect(request?.sql).toContain('"memory_items"."id" = ?');
        expect(request?.params).toContain(7);
    });

    it('finds enabled memory by normalized title in query code', async () => {
        mockDatabaseRows([
            {
                ...fullMemoryRow,
                title: '  Desktop   Workflow  ',
            },
        ]);

        const found = await findMemoryItemByNormalizedTitle('desktop workflow');

        expect(found?.id).toBe(7);
    });

    it('touches valid memories as last used', async () => {
        await touchMemoryItemsLastUsed([7, 7, -1], '2026-05-22T01:00:00.000Z');

        const request = getLastDatabaseRequest()?.request;
        expect(request?.sql).toContain('"last_used_at" = ?');
        expect(request?.params).toContain('2026-05-22T01:00:00.000Z');
        expect(request?.params).toContain(7);
        expect(request?.params).not.toContain(-1);
    });
});
