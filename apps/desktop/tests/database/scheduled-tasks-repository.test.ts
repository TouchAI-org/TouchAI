import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '@tests/database/sqliteHarness';
import { afterEach, describe, expect, it } from 'vitest';

import {
    createSqliteSchedulerRepository,
    type SqliteSchedulerRepository,
} from '@/database/queries/scheduledTasks';

type TaskRecord = Parameters<SqliteSchedulerRepository['insertTask']>[0];
type RunRecord = Parameters<SqliteSchedulerRepository['insertRun']>[0];

const DAY = 24 * 60 * 60 * 1_000;
const now = Date.now();

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
    return {
        id: 'schedule-1',
        name: 'Daily digest',
        prompt: 'Summarize',
        trigger: { type: 'cron', expression: '0 9 * * *' },
        timezone: 'Asia/Shanghai',
        modelId: 'model-1',
        providerId: 1,
        enabled: true,
        lastRunAt: null,
        nextRunAt: now + DAY,
        version: 1,
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
        ...overrides,
    };
}

function run(overrides: Partial<RunRecord> = {}): RunRecord {
    return {
        id: 'run-1',
        scheduleId: 'schedule-1',
        scheduleVersion: 1,
        scheduledFor: now,
        startedAt: now,
        finishedAt: now,
        outcome: 'completed',
        reason: null,
        backgroundTaskId: null,
        sessionId: null,
        turnId: null,
        createdAt: now,
        ...overrides,
    };
}

function repository(): SqliteSchedulerRepository {
    const database = openMigratedDatabase();
    routeQueriesTo(database);
    return createSqliteSchedulerRepository();
}

afterEach(() => {
    closeTestDatabases();
});

describe('user persists scheduled tasks and run history', () => {
    it('user sees every supported trigger and task metadata survive a database round trip', async () => {
        const scheduler = repository();
        await scheduler.insertTask(task());
        await scheduler.insertTask(
            task({
                id: 'schedule-once',
                name: 'One time',
                trigger: { type: 'once', timestamp: now + DAY },
                modelId: undefined,
                providerId: undefined,
                createdAt: now + 1,
            })
        );
        await scheduler.insertTask(
            task({
                id: 'schedule-interval',
                name: 'Interval',
                trigger: { type: 'interval', milliseconds: 60_000 },
                createdAt: now + 2,
            })
        );

        expect(await scheduler.listTasks()).toMatchObject([
            {
                id: 'schedule-1',
                name: 'Daily digest',
                trigger: { type: 'cron', expression: '0 9 * * *' },
                modelId: 'model-1',
                providerId: 1,
            },
            {
                id: 'schedule-once',
                trigger: { type: 'once', timestamp: now + DAY },
                modelId: undefined,
                providerId: undefined,
            },
            {
                id: 'schedule-interval',
                trigger: { type: 'interval', milliseconds: 60_000 },
            },
        ]);
        expect(await scheduler.findTask('schedule-once')).toMatchObject({
            name: 'One time',
            timezone: 'Asia/Shanghai',
        });
    });

    it('user gets updated schedules while deleted schedules stay out of normal lookup', async () => {
        const scheduler = repository();
        await scheduler.insertTask(task());

        await scheduler.updateTask(
            task({
                name: 'Edited digest',
                prompt: 'Edited prompt',
                trigger: { type: 'cron', expression: '30 10 * * *' },
                enabled: false,
                lastRunAt: now,
                nextRunAt: null,
                version: 2,
                updatedAt: now + 1,
            })
        );
        expect(await scheduler.findTask('schedule-1')).toMatchObject({
            name: 'Edited digest',
            prompt: 'Edited prompt',
            trigger: { type: 'cron', expression: '30 10 * * *' },
            enabled: false,
            version: 2,
        });

        await scheduler.updateTask(
            task({
                name: 'Deleted digest',
                enabled: false,
                nextRunAt: null,
                version: 3,
                deletedAt: now + 2,
                updatedAt: now + 2,
            })
        );
        expect(await scheduler.findTask('schedule-1')).toBeUndefined();
        expect(await scheduler.listTasks()).toEqual([]);
        await expect(
            scheduler.updateTask(task({ id: 'missing', name: 'Missing' }))
        ).rejects.toThrow('SCHEDULE_NOT_FOUND');
    });

    it('user sees active runs and completed history with linked background work', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        const scheduler = createSqliteSchedulerRepository();
        await scheduler.insertTask(task());
        database.exec(`
            INSERT INTO providers (id, name, driver, api_endpoint, logo)
            VALUES (1, 'Provider', 'openai', 'https://example.com', 'openai');
            INSERT INTO models (id, provider_id, name, model_id)
            VALUES (1, 1, 'Model', 'model-1');
            INSERT INTO sessions (id, session_id, title, model, provider_id)
            VALUES (10, 'scheduled-session', 'Scheduled work', 'model-1', 1);
            INSERT INTO session_turns (
                id, session_id, model_id, task_id, execution_mode, prompt_snapshot_json
            )
            VALUES (20, 10, 1, 'scheduled-work', 'background', '{}');
        `);
        await scheduler.insertRun(
            run({
                id: 'older',
                scheduledFor: now - 2_000,
                createdAt: now - 2_000,
            })
        );
        await scheduler.insertRun(
            run({
                id: 'active',
                scheduledFor: now - 1_000,
                startedAt: now - 1_000,
                finishedAt: null,
                outcome: null,
                createdAt: now - 1_000,
            })
        );

        expect(await scheduler.findActiveRun('schedule-1')).toMatchObject({ id: 'active' });
        expect((await scheduler.listActiveRuns()).map((entry) => entry.id)).toEqual(['active']);
        expect(
            await scheduler.insertRun(
                run({
                    id: 'duplicate-active',
                    scheduledFor: now - 1_000,
                    finishedAt: null,
                    outcome: null,
                })
            )
        ).toBe(false);

        await scheduler.updateRun('active', {
            scheduleVersion: 2,
            scheduledFor: now,
            startedAt: now - 500,
            finishedAt: now,
            outcome: 'failed',
            reason: 'provider rejected request',
            backgroundTaskId: 'background-1',
            sessionId: 10,
            turnId: 20,
            createdAt: now - 500,
        });

        expect(await scheduler.findActiveRun('schedule-1')).toBeUndefined();
        expect(await scheduler.listActiveRuns()).toEqual([]);
        expect(await scheduler.listRuns('schedule-1')).toMatchObject([
            {
                id: 'active',
                scheduleVersion: 2,
                outcome: 'failed',
                reason: 'provider rejected request',
                backgroundTaskId: 'background-1',
                sessionId: 10,
                turnId: 20,
            },
            { id: 'older', outcome: 'completed' },
        ]);
    });

    it('user sees expired and overflow history pruned while active work remains recoverable', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        const scheduler = createSqliteSchedulerRepository();
        await scheduler.insertTask(task());
        await scheduler.insertRun(
            run({
                id: 'expired-active',
                scheduledFor: now - 100 * DAY,
                outcome: null,
                finishedAt: null,
            })
        );
        await scheduler.insertRun(run({ id: 'expired-finished', scheduledFor: now - 100 * DAY }));

        const insert = database.prepare(
            `INSERT INTO scheduled_task_runs (
                id, schedule_id, schedule_version, scheduled_for, started_at, finished_at,
                outcome, reason, background_task_id, session_id, turn_id, created_at
            ) VALUES (?, 'schedule-1', 1, ?, ?, ?, 'completed', NULL, NULL, NULL, NULL, ?)`
        );
        database.exec('BEGIN');
        for (let index = 0; index < 1_001; index += 1) {
            const at = now - index * 1_000;
            insert.run(`history-${index}`, at, at, at, at);
        }
        database.exec('COMMIT');

        await scheduler.pruneRuns('schedule-1');

        expect(await scheduler.listRuns('schedule-1')).toHaveLength(1_000);
        expect((await scheduler.listActiveRuns()).map((entry) => entry.id)).toEqual([
            'expired-active',
        ]);
        expect(
            database
                .prepare('SELECT id FROM scheduled_task_runs WHERE id = ?')
                .get('expired-finished')
        ).toBeUndefined();
    });
});
