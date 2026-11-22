// Copyright (c) 2026. 千诚. Licensed under GPL v3

export type JsonValue =
    | string
    | number
    | boolean
    | null
    | JsonValue[]
    | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export interface CronTrigger {
    type: 'cron';
    expression: string;
}

export interface IntervalTrigger {
    type: 'interval';
    milliseconds: number;
}

export interface OnceTrigger {
    type: 'once';
    timestamp: number;
}

export interface EventTrigger {
    type: 'event';
    eventType: string;
    eventConfig?: JsonObject;
}

export type ScheduleTrigger = CronTrigger | IntervalTrigger | OnceTrigger | EventTrigger;

export interface ScheduledTask {
    id: string;
    name: string;
    prompt: string;
    trigger: ScheduleTrigger;
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

export interface EventTriggerHandler {
    eventType: string;
    displayName: string;
    description: string;
    configSchema?: JsonObject; // 配置参数的 JSON Schema
    setup: (config: JsonObject, callback: () => void) => Promise<() => void>;
}

export type ScheduledTaskRunOutcome =
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'skipped_overlap'
    | 'missed'
    | 'skipped_dst';

/** `outcome = null` means the shared background task is still active. */
export interface ScheduledTaskRun {
    id: string;
    scheduleId: string;
    scheduleVersion: number;
    scheduledFor: number;
    startedAt: number | null;
    finishedAt: number | null;
    outcome: ScheduledTaskRunOutcome | null;
    reason: string | null;
    backgroundTaskId: string | null;
    sessionId: number | null;
    turnId: number | null;
    createdAt: number;
}

export interface SchedulerRepository {
    insertTask(task: ScheduledTask): Promise<void>;
    updateTask(task: ScheduledTask): Promise<void>;
    listTasks(): Promise<ScheduledTask[]>;
    findTask(taskId: string): Promise<ScheduledTask | undefined>;
    insertRun(run: ScheduledTaskRun): Promise<boolean>;
    updateRun(
        runId: string,
        patch: Partial<Omit<ScheduledTaskRun, 'id' | 'scheduleId'>>
    ): Promise<void>;
    findActiveRun(scheduleId: string): Promise<ScheduledTaskRun | undefined>;
    listActiveRuns(): Promise<ScheduledTaskRun[]>;
    listRuns(scheduleId: string): Promise<ScheduledTaskRun[]>;
    pruneRuns(scheduleId: string): Promise<void>;
}

export interface SchedulerCompletion {
    outcome: Exclude<ScheduledTaskRunOutcome, 'skipped_overlap' | 'missed' | 'skipped_dst'>;
    sessionId: number | null;
    turnId: number | null;
    errorSummary: string | null;
}

export interface SchedulerExecution {
    backgroundTaskId: string;
    sessionId: number | null;
    completion: Promise<SchedulerCompletion>;
}
