import { inject, type InjectionKey } from 'vue';

export interface CronTrigger {
    type: 'cron';
    expression: string;
}

export interface OnceTrigger {
    type: 'once';
    timestamp: number;
}

export interface IntervalTrigger {
    type: 'interval';
    milliseconds: number;
}

export interface EventTrigger {
    type: 'event';
    eventType: string;
    eventConfig?: Record<string, unknown>;
}

export type ScheduleTrigger = CronTrigger | OnceTrigger | IntervalTrigger | EventTrigger;
export type SupportedScheduleTrigger = CronTrigger | OnceTrigger | IntervalTrigger;

export interface ScheduledTaskDraft {
    name: string;
    prompt: string;
    trigger: SupportedScheduleTrigger;
    timezone?: string;
    modelId?: string;
    providerId?: number;
    enabled?: boolean;
}

export type ScheduledTaskPatch = Partial<ScheduledTaskDraft>;

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

export type ScheduledTaskRunOutcome =
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'skipped_overlap'
    | 'missed'
    | 'skipped_dst';

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

export { zonedDateTimeToTimestamp } from '@/modules/scheduler/public';

export type ScheduledTasksErrorCode =
    | 'SCHEDULED_TASKS_UNAVAILABLE'
    | 'SCHEDULED_TASKS_UNCONFIRMED'
    | 'SCHEDULED_TASKS_FAILED'
    | 'SCHEDULE_INVALID_INPUT';

export class ScheduledTasksError extends Error {
    constructor(
        readonly code: ScheduledTasksErrorCode,
        readonly outcome: 'none' | 'unknown' = 'none'
    ) {
        super(code);
        this.name = 'ScheduledTasksError';
    }
}

export interface ScheduledTasksApi {
    list(): Promise<ScheduledTask[]>;
    create(input: ScheduledTaskDraft): Promise<ScheduledTask>;
    update(taskId: string, input: ScheduledTaskPatch): Promise<ScheduledTask | undefined>;
    remove(taskId: string): Promise<boolean>;
    runs(taskId: string): Promise<ScheduledTaskRun[]>;
}

export const scheduledTasksApiKey: InjectionKey<ScheduledTasksApi> = Symbol(
    'touchai.scheduler.administration'
);

export function useScheduledTasksApi(): ScheduledTasksApi {
    const api = inject(scheduledTasksApiKey);
    if (!api) throw new ScheduledTasksError('SCHEDULED_TASKS_UNAVAILABLE');
    return api;
}
