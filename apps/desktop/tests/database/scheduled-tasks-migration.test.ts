import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
    applyMigrationsAfter,
    createMigrationFixtureDatabase,
    listIndexes,
} from './utils/migrations';

const PREVIOUS_TAG = '0006_blue_solo';
const MIGRATION_SQL = readFileSync('src/database/drizzle/0007_aspiring_proteus.sql', 'utf8');

function tableExists(
    database: ReturnType<typeof createMigrationFixtureDatabase>,
    name: string
): boolean {
    return Boolean(
        database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name)
    );
}

function insertSchedule(database: ReturnType<typeof createMigrationFixtureDatabase>) {
    database
        .prepare(
            `INSERT INTO scheduled_tasks (
                id, title, prompt, model_id, provider_id, trigger_type, trigger_config,
                timezone, enabled, next_run_at, last_run_at, version, deleted_at,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
            'schedule-1',
            'Daily digest',
            'Summarize',
            'deepseek-v4',
            7,
            'cron',
            '{"expression":"0 9 * * *"}',
            'Asia/Shanghai',
            1,
            1_800_000_000_000,
            null,
            1,
            null,
            1_799_000_000_000,
            1_799_000_000_000
        );
}

function insertRun(database: ReturnType<typeof createMigrationFixtureDatabase>, id = 'run-1') {
    database
        .prepare(
            `INSERT INTO scheduled_task_runs (
                id, schedule_id, schedule_version, scheduled_for, started_at, finished_at,
                outcome, reason, background_task_id, session_id, turn_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
            id,
            'schedule-1',
            1,
            1_800_000_000_000,
            1_800_000_001_000,
            1_800_000_002_000,
            'completed',
            null,
            'background-1',
            null,
            null,
            1_800_000_001_000
        );
}

describe('user upgrades a database created before scheduled tasks existed', () => {
    it('user keeps existing conversations while gaining schedule and run tables', () => {
        const database = createMigrationFixtureDatabase(PREVIOUS_TAG);
        try {
            database
                .prepare(
                    `INSERT INTO sessions (
                        id, session_id, title, model, message_count, created_at, updated_at
                    ) VALUES (1, 'existing-session', 'Existing', 'model', 0, ?, ?)`
                )
                .run('2026-01-01 00:00:00', '2026-01-01 00:00:00');

            applyMigrationsAfter(database, PREVIOUS_TAG);

            expect(tableExists(database, 'scheduled_tasks')).toBe(true);
            expect(tableExists(database, 'scheduled_task_runs')).toBe(true);
            expect(database.prepare('SELECT title FROM sessions WHERE id = 1').get()).toEqual({
                title: 'Existing',
            });
            expect(listIndexes(database, 'scheduled_task_runs')).toContain(
                'scheduled_task_runs_occurrence_unique'
            );
        } finally {
            database.close();
        }
    });

    it('user cannot duplicate an occurrence while soft delete preserves its history', () => {
        const database = createMigrationFixtureDatabase(PREVIOUS_TAG);
        try {
            applyMigrationsAfter(database, PREVIOUS_TAG);
            insertSchedule(database);
            insertRun(database);

            expect(() => insertRun(database, 'run-duplicate')).toThrow();

            database
                .prepare('UPDATE scheduled_tasks SET deleted_at = ?, enabled = 0 WHERE id = ?')
                .run(Date.UTC(2026, 0, 2), 'schedule-1');

            expect(
                database
                    .prepare('SELECT outcome FROM scheduled_task_runs WHERE schedule_id = ?')
                    .get('schedule-1')
            ).toEqual({ outcome: 'completed' });
        } finally {
            database.close();
        }
    });

    it('user can roll back an interrupted upgrade without partial schedule tables', () => {
        const database = createMigrationFixtureDatabase(PREVIOUS_TAG);
        try {
            database.exec('BEGIN');
            for (const statement of MIGRATION_SQL.split('--> statement-breakpoint')) {
                if (statement.trim()) database.exec(statement);
            }
            database.exec('ROLLBACK');

            expect(tableExists(database, 'scheduled_tasks')).toBe(false);
            expect(tableExists(database, 'scheduled_task_runs')).toBe(false);
        } finally {
            database.close();
        }
    });
});
