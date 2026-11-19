import { emitTo } from '@tauri-apps/api/event';
import { mockWindows } from '@tauri-apps/api/mocks';
import { createAgentWindowFixture } from '@tests/utils/agentWindow';
import { getTauriInvokeCalls, mockTauriCommand } from '@tests/utils/tauri';
import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { initializeAgentWindow } from '@/app/bootstrap/agent';

const windows: ReturnType<typeof initializeAgentWindow>[] = [];
afterEach(async () => {
    for (const host of windows.splice(0).reverse()) await host.dispose();
});
async function clients() {
    const fixture = createAgentWindowFixture();
    windows.push(fixture.window);
    await fixture.window.ready;
    mockWindows('settings');
    const settings = initializeAgentWindow();
    windows.push(settings);
    return { ...fixture, settings };
}

describe('given production data management through main', () => {
    it('user given saved history when settings reads statistics and clears messages then preserves sessions and the existing deletion behavior', async () => {
        const fixture = await clients();
        fixture.database
            .exec(`INSERT INTO sessions (id, session_id, title, model) VALUES (7, 'data-fixture', 'Saved', 'fixture-model');
            INSERT INTO messages (id, session_id, role) VALUES (8, 7, 'user');`);
        expect(await fixture.settings.dataManagement!.stats()).toEqual({
            sessions: 1,
            messages: 1,
            sessionTurns: 0,
        });
        await fixture.settings.dataManagement!.clear('messages');
        expect(await fixture.settings.dataManagement!.stats()).toEqual({
            sessions: 1,
            messages: 0,
            sessionTurns: 0,
        });
        expect(fixture.window.dataManagement).toBeUndefined();
    });

    it('user given an export destination when settings exports then preserves the native command and progress without a local backup writer', async () => {
        const fixture = await clients();
        mockTauriCommand('plugin:dialog|save', '/fixture/backup.db');
        const progress: number[] = [];
        expect(
            await fixture.settings.dataManagement!.exportDatabase((_text, value) =>
                progress.push(value)
            )
        ).toBe('/fixture/backup.db');
        expect(getTauriInvokeCalls('database_export_backup').map(({ payload }) => payload)).toEqual(
            [{ targetPath: '/fixture/backup.db' }]
        );
        expect(progress).toEqual([30, 100]);
    });

    it.each(['full', 'chat_only'] as const)(
        'user given an approved %s import when native succeeds then records the same restart notice bytes',
        async (mode) => {
            const fixture = await clients();
            mockTauriCommand('plugin:dialog|open', '/fixture/import.db');
            expect(await fixture.settings.dataManagement!.importDatabase(mode)).toBe(true);
            expect(
                getTauriInvokeCalls('database_import_backup').map(({ payload }) => payload)
            ).toEqual([{ request: { sourcePath: '/fixture/import.db', mode } }]);
            expect(
                fixture.database
                    .prepare('SELECT value FROM touchai_meta WHERE key = ?')
                    .get('import_success')?.value
            ).toBe(JSON.stringify({ type: 'import-success', version: 1, importMode: mode }));
        }
    );

    it('user given cancelled backup pickers when leaving the dialogs then starts no native backup or import', async () => {
        const fixture = await clients();
        mockTauriCommand('plugin:dialog|save', null);
        mockTauriCommand('plugin:dialog|open', null);
        await expect(fixture.settings.dataManagement!.exportDatabase()).rejects.toMatchObject({
            code: 'DATABASE_BACKUP_CANCELLED',
        });
        expect(await fixture.settings.dataManagement!.importDatabase('full')).toBe(false);
        expect(getTauriInvokeCalls('database_export_backup')).toEqual([]);
        expect(getTauriInvokeCalls('database_import_backup')).toEqual([]);
    });

    it('user given a failed native import when trying explicitly again then receives a safe failure without a fabricated success marker', async () => {
        const fixture = await clients();
        mockTauriCommand('plugin:dialog|open', '/fixture/import.db');
        mockTauriCommand('database_import_backup', () => {
            throw new Error('private native database failure');
        });
        await expect(fixture.settings.dataManagement!.importDatabase('full')).rejects.toMatchObject(
            { code: 'DATA_MANAGEMENT_UNCONFIRMED', message: 'DATA_MANAGEMENT_UNCONFIRMED' }
        );
        expect(
            fixture.database.prepare('SELECT count(*) AS count FROM touchai_meta').get()
        ).toEqual({ count: 0 });
        expect(getTauriInvokeCalls('database_import_backup')).toHaveLength(1);
        mockTauriCommand('database_import_backup', undefined);
        expect(await fixture.settings.dataManagement!.importDatabase('full')).toBe(true);
    });

    it('user given settings without main when requesting a clear then receives a bounded refusal without a local deletion', async () => {
        vi.useFakeTimers();
        const fixture = createAgentWindowFixture('settings');
        windows.push(fixture.window);
        const failure = expect(
            fixture.window.dataManagement!.clear('sessions')
        ).rejects.toMatchObject({ code: 'DATA_MANAGEMENT_UNCONFIRMED' });
        await vi.advanceTimersByTimeAsync(60_000);
        await failure;
        expect(
            getTauriInvokeCalls('database_query').filter(({ payload }) =>
                JSON.stringify(payload).includes('delete')
            )
        ).toEqual([]);
    });

    it('user given repeated and malformed commands when an import is admitted then receives only one native effect and no substituted clear', async () => {
        const fixture = await clients();
        fixture.database.exec(
            "INSERT INTO sessions (id, session_id, title, model) VALUES (7, 'kept', 'Saved', 'fixture-model')"
        );
        let complete!: () => void;
        mockTauriCommand(
            'database_import_backup',
            () =>
                new Promise<void>((resolve) => {
                    complete = resolve;
                })
        );
        const request = {
            requestId: crypto.randomUUID(),
            createdAt: Date.now(),
            from: 'settings',
            command: { operation: 'import', sourcePath: '/fixture/import.db', mode: 'full' },
        };
        await emitTo('main', 'data-management:request', request);
        await flushPromises();
        await emitTo('main', 'data-management:request', request);
        await emitTo('main', 'data-management:request', {
            ...request,
            command: { operation: 'clear', category: 'sessions' },
        });
        await emitTo('main', 'data-management:request', {
            ...request,
            requestId: crypto.randomUUID(),
            command: { operation: 'clear', category: 'everything' },
        });
        await emitTo('main', 'data-management:request', {
            ...request,
            requestId: crypto.randomUUID(),
            from: 'tray-menu',
            command: { operation: 'clear', category: 'sessions' },
        });
        await flushPromises();
        expect(getTauriInvokeCalls('database_import_backup')).toHaveLength(1);
        expect(fixture.database.prepare('SELECT count(*) AS count FROM sessions').get()).toEqual({
            count: 1,
        });
        complete();
        await flushPromises();
        await emitTo('main', 'data-management:request', request);
        await flushPromises();
        expect(getTauriInvokeCalls('database_import_backup')).toHaveLength(1);
    });

    it('user given an admitted native import when main closes then sees an unconfirmed outcome without a later database write or local replay', async () => {
        const fixture = await clients();
        vi.useFakeTimers();
        mockTauriCommand('plugin:dialog|open', '/fixture/import.db');
        let complete!: () => void;
        mockTauriCommand(
            'database_import_backup',
            () =>
                new Promise<void>((resolve) => {
                    complete = resolve;
                })
        );
        const failure = expect(
            fixture.settings.dataManagement!.importDatabase('full')
        ).rejects.toMatchObject({ code: 'DATA_MANAGEMENT_UNCONFIRMED' });
        await flushPromises();
        const disposal = fixture.window.dispose();
        await flushPromises();
        complete();
        await disposal;
        await vi.advanceTimersByTimeAsync(60_000);
        await failure;
        expect(
            fixture.database.prepare('SELECT count(*) AS count FROM touchai_meta').get()
        ).toEqual({ count: 0 });
        expect(getTauriInvokeCalls('database_import_backup')).toHaveLength(1);
    });

    it('user given a full command history when repeating an old export then cannot replay a completed effect through eviction or expiry', async () => {
        const fixture = await clients();
        mockTauriCommand('plugin:dialog|save', '/fixture/backup.db');
        vi.useFakeTimers();
        for (let index = 0; index < 64; index++)
            await fixture.settings.dataManagement!.exportDatabase();
        const first = getTauriInvokeCalls('plugin:event|emit_to').find(
            ({ payload }) =>
                payload && 'event' in payload && payload.event === 'data-management:request'
        )!.payload!;
        await expect(fixture.settings.dataManagement!.exportDatabase()).rejects.toMatchObject({
            code: 'DATA_MANAGEMENT_UNAVAILABLE',
        });
        await emitTo(
            'main',
            'data-management:request',
            'payload' in first ? first.payload : undefined
        );
        await flushPromises();
        expect(getTauriInvokeCalls('database_export_backup')).toHaveLength(64);
        await vi.advanceTimersByTimeAsync(300_000);
        await emitTo(
            'main',
            'data-management:request',
            'payload' in first ? first.payload : undefined
        );
        await flushPromises();
        expect(getTauriInvokeCalls('database_export_backup')).toHaveLength(64);
        await fixture.settings.dataManagement!.exportDatabase();
        expect(getTauriInvokeCalls('database_export_backup')).toHaveLength(65);
    });
});
