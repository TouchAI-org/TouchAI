import { mockWindows } from '@tauri-apps/api/mocks';
import { createAgentWindowFixture } from '@tests/utils/agentWindow';
import { afterEach, describe, expect, it } from 'vitest';

import { initializeAgentWindow } from '@/app/bootstrap/agent';

const windows: ReturnType<typeof initializeAgentWindow>[] = [];

afterEach(async () => {
    for (const host of windows.splice(0).reverse()) await host.dispose();
});

async function main() {
    const fixture = createAgentWindowFixture();
    windows.push(fixture.window);
    await fixture.window.ready;
    return fixture;
}

function settings() {
    mockWindows('settings');
    const client = initializeAgentWindow();
    windows.push(client);
    return client;
}

describe('user manages scheduled tasks from settings', () => {
    it('user creates and pauses a recurring task through the settings projection', async () => {
        const fixture = await main();
        const api = settings().scheduledTasks!;

        const created = await api.create({
            name: 'Morning digest',
            prompt: 'Summarize my day',
            trigger: { type: 'cron', expression: '0 9 * * *' },
            timezone: 'Asia/Shanghai',
            modelId: 'fixture-model',
            providerId: 1,
        });

        expect((await api.list()).map((task) => task.id)).toEqual([created.id]);
        expect(await api.update(created.id, { enabled: false })).toMatchObject({
            id: created.id,
            enabled: false,
            nextRunAt: null,
            version: 2,
        });
        expect(
            fixture.database
                .prepare(
                    'SELECT title, prompt, timezone, enabled, model_id, provider_id FROM scheduled_tasks WHERE id = ?'
                )
                .get(created.id)
        ).toEqual({
            title: 'Morning digest',
            prompt: 'Summarize my day',
            timezone: 'Asia/Shanghai',
            enabled: 0,
            model_id: 'fixture-model',
            provider_id: 1,
        });
    });

    it('user gets a recoverable validation error and no row for an invalid cron expression', async () => {
        const fixture = await main();
        const api = settings().scheduledTasks!;

        await expect(
            api.create({
                name: 'Broken',
                prompt: 'Do work',
                trigger: { type: 'cron', expression: 'not cron' },
                timezone: 'UTC',
            })
        ).rejects.toMatchObject({ code: 'SCHEDULE_INVALID_INPUT' });

        expect(
            fixture.database.prepare('SELECT COUNT(*) AS count FROM scheduled_tasks').get()
        ).toEqual({ count: 0 });
    });

    it('user deletes a task while preserving its visible run history', async () => {
        const fixture = await main();
        const api = settings().scheduledTasks!;
        const created = await api.create({
            name: 'Keep history',
            prompt: 'Run',
            trigger: { type: 'cron', expression: '0 9 * * *' },
            timezone: 'UTC',
        });
        fixture.database
            .prepare(
                `INSERT INTO scheduled_task_runs (
                    id, schedule_id, schedule_version, scheduled_for, started_at, finished_at,
                    outcome, reason, background_task_id, session_id, turn_id, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
                'run-visible',
                created.id,
                1,
                1_800_000_000_000,
                1_800_000_001_000,
                1_800_000_002_000,
                'missed',
                'coalesced_while_app_closed',
                null,
                null,
                null,
                1_800_000_001_000
            );

        expect(await api.runs(created.id)).toMatchObject([
            {
                id: 'run-visible',
                outcome: 'missed',
                reason: 'coalesced_while_app_closed',
            },
        ]);
        expect(await api.remove(created.id)).toBe(true);
        expect(
            fixture.database
                .prepare('SELECT deleted_at FROM scheduled_tasks WHERE id = ?')
                .get(created.id)
        ).toMatchObject({ deleted_at: expect.any(Number) });
        expect(
            fixture.database
                .prepare('SELECT outcome FROM scheduled_task_runs WHERE id = ?')
                .get('run-visible')
        ).toEqual({ outcome: 'missed' });
    });
});
