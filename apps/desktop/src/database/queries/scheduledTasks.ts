import { and, desc, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';

import { db } from '../index';
import {
    type NewScheduledTask,
    type NewScheduledTaskRun,
    type ScheduledTask as ScheduledTaskRow,
    type ScheduledTaskRun as ScheduledTaskRunRow,
    scheduledTaskRuns,
    scheduledTasks,
} from '../schema';

type ScheduleTriggerRecord =
    | { type: 'cron'; expression: string }
    | { type: 'once'; timestamp: number }
    | { type: 'interval'; milliseconds: number };

interface ScheduledTaskRecord {
    id: string;
    name: string;
    prompt: string;
    trigger: ScheduleTriggerRecord;
    timezone: string;
    modelId?: string;
    providerId?: number;
    enabled: boolean;
    lastRunAt: number | null;
    nextRunAt: number | null;
    version: number;
    deletedAt: number | null;
    createdAt: number;
    updatedAt: number;
}

type ScheduledTaskRunOutcomeRecord =
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'skipped_overlap'
    | 'missed'
    | 'skipped_dst';

interface ScheduledTaskRunRecord {
    id: string;
    scheduleId: string;
    scheduleVersion: number;
    scheduledFor: number;
    startedAt: number | null;
    finishedAt: number | null;
    outcome: ScheduledTaskRunOutcomeRecord | null;
    reason: string | null;
    backgroundTaskId: string | null;
    sessionId: number | null;
    turnId: number | null;
    createdAt: number;
}

const HISTORY_DAYS = 90;
const HISTORY_LIMIT = 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

function parseTrigger(row: ScheduledTaskRow): ScheduleTriggerRecord {
    const config = JSON.parse(row.trigger_config) as Record<string, unknown>;
    switch (row.trigger_type) {
        case 'cron':
            return {
                type: 'cron',
                expression: String(config.expression ?? ''),
            };
        case 'once':
            return {
                type: 'once',
                timestamp: Number(config.timestamp),
            };
        case 'interval':
            return {
                type: 'interval',
                milliseconds: Number(config.milliseconds),
            };
    }
}

function triggerConfig(trigger: ScheduleTriggerRecord): string {
    switch (trigger.type) {
        case 'cron':
            return JSON.stringify({ expression: trigger.expression });
        case 'once':
            return JSON.stringify({ timestamp: trigger.timestamp });
        case 'interval':
            return JSON.stringify({ milliseconds: trigger.milliseconds });
    }
}

function toTask(row: ScheduledTaskRow): ScheduledTaskRecord {
    return {
        id: row.id,
        name: row.title,
        prompt: row.prompt,
        trigger: parseTrigger(row),
        timezone: row.timezone,
        modelId: row.model_id ?? undefined,
        providerId: row.provider_id ?? undefined,
        enabled: row.enabled === 1,
        lastRunAt: row.last_run_at,
        nextRunAt: row.next_run_at,
        version: row.version,
        deletedAt: row.deleted_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function toTaskRow(task: ScheduledTaskRecord): NewScheduledTask {
    return {
        id: task.id,
        title: task.name,
        prompt: task.prompt,
        model_id: task.modelId ?? null,
        provider_id: task.providerId ?? null,
        trigger_type: task.trigger.type,
        trigger_config: triggerConfig(task.trigger),
        timezone: task.timezone,
        enabled: task.enabled ? 1 : 0,
        next_run_at: task.nextRunAt,
        last_run_at: task.lastRunAt,
        version: task.version,
        deleted_at: task.deletedAt,
        created_at: task.createdAt,
        updated_at: task.updatedAt,
    };
}

function toRun(row: ScheduledTaskRunRow): ScheduledTaskRunRecord {
    return {
        id: row.id,
        scheduleId: row.schedule_id,
        scheduleVersion: row.schedule_version,
        scheduledFor: row.scheduled_for,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        outcome: row.outcome,
        reason: row.reason,
        backgroundTaskId: row.background_task_id,
        sessionId: row.session_id,
        turnId: row.turn_id,
        createdAt: row.created_at,
    };
}

function toRunRow(run: ScheduledTaskRunRecord): NewScheduledTaskRun {
    return {
        id: run.id,
        schedule_id: run.scheduleId,
        schedule_version: run.scheduleVersion,
        scheduled_for: run.scheduledFor,
        started_at: run.startedAt,
        finished_at: run.finishedAt,
        outcome: run.outcome,
        reason: run.reason,
        background_task_id: run.backgroundTaskId,
        session_id: run.sessionId,
        turn_id: run.turnId,
        created_at: run.createdAt,
    };
}

export class SqliteSchedulerRepository {
    async insertTask(task: ScheduledTaskRecord): Promise<void> {
        await db.insert(scheduledTasks).values(toTaskRow(task)).run();
    }

    async updateTask(task: ScheduledTaskRecord): Promise<void> {
        const updated = await db
            .update(scheduledTasks)
            .set(toTaskRow(task))
            .where(eq(scheduledTasks.id, task.id))
            .returning({ id: scheduledTasks.id })
            .get();
        if (!updated) throw new Error('SCHEDULE_NOT_FOUND');
    }

    async listTasks(): Promise<ScheduledTaskRecord[]> {
        const rows = await db
            .select()
            .from(scheduledTasks)
            .where(isNull(scheduledTasks.deleted_at))
            .orderBy(scheduledTasks.created_at, scheduledTasks.id)
            .all();
        return rows.map(toTask);
    }

    async findTask(taskId: string): Promise<ScheduledTaskRecord | undefined> {
        const row = await db
            .select()
            .from(scheduledTasks)
            .where(and(eq(scheduledTasks.id, taskId), isNull(scheduledTasks.deleted_at)))
            .get();
        return row ? toTask(row) : undefined;
    }

    async insertRun(run: ScheduledTaskRunRecord): Promise<boolean> {
        const inserted = await db
            .insert(scheduledTaskRuns)
            .values(toRunRow(run))
            .onConflictDoNothing({
                target: [
                    scheduledTaskRuns.schedule_id,
                    scheduledTaskRuns.schedule_version,
                    scheduledTaskRuns.scheduled_for,
                ],
            })
            .returning({ id: scheduledTaskRuns.id })
            .get();
        return Boolean(inserted);
    }

    async updateRun(
        runId: string,
        patch: Partial<Omit<ScheduledTaskRunRecord, 'id' | 'scheduleId'>>
    ): Promise<void> {
        const row: Partial<NewScheduledTaskRun> = {};
        if ('scheduleVersion' in patch) row.schedule_version = patch.scheduleVersion;
        if ('scheduledFor' in patch) row.scheduled_for = patch.scheduledFor;
        if ('startedAt' in patch) row.started_at = patch.startedAt;
        if ('finishedAt' in patch) row.finished_at = patch.finishedAt;
        if ('outcome' in patch) row.outcome = patch.outcome;
        if ('reason' in patch) row.reason = patch.reason;
        if ('backgroundTaskId' in patch) row.background_task_id = patch.backgroundTaskId;
        if ('sessionId' in patch) row.session_id = patch.sessionId;
        if ('turnId' in patch) row.turn_id = patch.turnId;
        if ('createdAt' in patch) row.created_at = patch.createdAt;
        await db.update(scheduledTaskRuns).set(row).where(eq(scheduledTaskRuns.id, runId)).run();
    }

    async findActiveRun(scheduleId: string): Promise<ScheduledTaskRunRecord | undefined> {
        const row = await db
            .select()
            .from(scheduledTaskRuns)
            .where(
                and(
                    eq(scheduledTaskRuns.schedule_id, scheduleId),
                    isNull(scheduledTaskRuns.outcome)
                )
            )
            .orderBy(desc(scheduledTaskRuns.started_at), desc(scheduledTaskRuns.created_at))
            .get();
        return row ? toRun(row) : undefined;
    }

    async listActiveRuns(): Promise<ScheduledTaskRunRecord[]> {
        const rows = await db
            .select()
            .from(scheduledTaskRuns)
            .where(isNull(scheduledTaskRuns.outcome))
            .orderBy(desc(scheduledTaskRuns.created_at))
            .all();
        return rows.map(toRun);
    }

    async listRuns(scheduleId: string): Promise<ScheduledTaskRunRecord[]> {
        const cutoff = Date.now() - HISTORY_DAYS * DAY_MS;
        const rows = await db
            .select()
            .from(scheduledTaskRuns)
            .where(
                and(
                    eq(scheduledTaskRuns.schedule_id, scheduleId),
                    sql`${scheduledTaskRuns.scheduled_for} >= ${cutoff}`
                )
            )
            .orderBy(
                desc(scheduledTaskRuns.scheduled_for),
                desc(scheduledTaskRuns.created_at),
                desc(scheduledTaskRuns.id)
            )
            .limit(HISTORY_LIMIT)
            .all();
        return rows.map(toRun);
    }

    async pruneRuns(scheduleId: string): Promise<void> {
        const cutoff = Date.now() - HISTORY_DAYS * DAY_MS;
        await db
            .delete(scheduledTaskRuns)
            .where(
                and(
                    eq(scheduledTaskRuns.schedule_id, scheduleId),
                    isNotNull(scheduledTaskRuns.outcome),
                    lt(scheduledTaskRuns.scheduled_for, cutoff)
                )
            )
            .run();
        const overflow = await db
            .select({ id: scheduledTaskRuns.id })
            .from(scheduledTaskRuns)
            .where(
                and(
                    eq(scheduledTaskRuns.schedule_id, scheduleId),
                    isNotNull(scheduledTaskRuns.outcome)
                )
            )
            .orderBy(
                desc(scheduledTaskRuns.scheduled_for),
                desc(scheduledTaskRuns.created_at),
                desc(scheduledTaskRuns.id)
            )
            // SQLite requires a LIMIT whenever OFFSET is used; -1 is omitted by Drizzle.
            .limit(Number.MAX_SAFE_INTEGER)
            .offset(HISTORY_LIMIT)
            .all();
        if (overflow.length === 0) return;
        await db
            .delete(scheduledTaskRuns)
            .where(
                inArray(
                    scheduledTaskRuns.id,
                    overflow.map((run) => run.id)
                )
            )
            .run();
    }
}

export function createSqliteSchedulerRepository(): SqliteSchedulerRepository {
    return new SqliteSchedulerRepository();
}
