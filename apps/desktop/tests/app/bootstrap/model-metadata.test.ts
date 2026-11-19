import { mockWindows } from '@tauri-apps/api/mocks';
import { createAgentWindowFixture } from '@tests/utils/agentWindow';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { initializeAgentWindow } from '@/app/bootstrap/agent';

const windows: ReturnType<typeof initializeAgentWindow>[] = [];
afterEach(async () => {
    for (const host of windows.splice(0).reverse()) await host.dispose();
});

describe('given production model metadata queries', () => {
    it('user given saved metadata when settings queries freshness then receives main owned values without a persistence capability', async () => {
        const fixture = createAgentWindowFixture();
        windows.push(fixture.window);
        await fixture.window.ready;
        fixture.database
            .prepare('INSERT INTO statistics (key, value) VALUES (?, ?)')
            .run('model_metadata_last_updated_at', '2026-11-17T00:00:00.000Z');
        mockWindows('settings');
        const settings = initializeAgentWindow();
        windows.push(settings);
        expect(await settings.metadata.isMissing()).toBe(true);
        expect(await settings.metadata.readLastUpdatedAt()).toBe('2026-11-17T00:00:00.000Z');
        expect(Object.keys(settings.metadata).sort()).toEqual([
            'isMissing',
            'readLastUpdatedAt',
            'refresh',
        ]);
        expect(fixture.window.api.listActiveTasks()).toEqual([]);
    });

    it('user given settings without main when querying metadata then receives a bounded failure without reading its local database', async () => {
        vi.useFakeTimers();
        const fixture = createAgentWindowFixture('settings');
        windows.push(fixture.window);
        const pending = fixture.window.metadata.readLastUpdatedAt();
        const failure = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
        await vi.advanceTimersByTimeAsync(60_000);
        await failure;
        expect(fixture.database.prepare('SELECT count(*) AS count FROM statistics').get()).toEqual({
            count: 0,
        });
    });

    it('user given a detached metadata client when querying again then receives cancellation without a replacement owner', async () => {
        const fixture = createAgentWindowFixture();
        windows.push(fixture.window);
        await fixture.window.ready;
        mockWindows('settings');
        const settings = initializeAgentWindow();
        windows.push(settings);
        await settings.dispose();
        await expect(settings.metadata.isMissing()).rejects.toMatchObject({
            code: 'REQUEST_CANCELLED',
        });
        expect(fixture.window.api.listActiveTasks()).toEqual([]);
    });
});
