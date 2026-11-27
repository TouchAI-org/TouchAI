import {
    type ScheduledTask,
    type ScheduledTaskRun,
    zonedDateTimeToTimestamp,
} from '@/app/api/scheduler/administration';
import { type MessageKey, t } from '@/i18n';

const DAILY = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/;
const WEEKDAYS = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+1-5$/;
const WEEKLY = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+1$/;

export type RecurringPreset = 'daily' | 'weekdays' | 'weekly' | 'custom';

export function splitCronTime(expression: string): { hour: number; minute: number } | null {
    const match = DAILY.exec(expression);
    if (!match) return null;
    const minute = Number(match[1]);
    const hour = Number(match[2]);
    return minute >= 0 && minute < 60 && hour >= 0 && hour < 24 ? { hour, minute } : null;
}

export function detectCronPreset(expression: string): RecurringPreset {
    if (WEEKDAYS.test(expression)) return 'weekdays';
    if (WEEKLY.test(expression)) return 'weekly';
    if (DAILY.test(expression)) return 'daily';
    return 'custom';
}

export function buildCronExpression(preset: RecurringPreset, time: string): string {
    const [hour = '9', minute = '0'] = time.split(':');
    switch (preset) {
        case 'weekdays':
            return `${Number(minute)} ${Number(hour)} * * 1-5`;
        case 'weekly':
            return `${Number(minute)} ${Number(hour)} * * 1`;
        case 'daily':
        case 'custom':
            return `${Number(minute)} ${Number(hour)} * * *`;
    }
}

export function formatDateTime(timestamp: number | null, timezone: string, locale: string): string {
    if (timestamp === null) return t('settings.scheduledTasks.never');
    try {
        return new Intl.DateTimeFormat(locale, {
            timeZone: timezone,
            year: 'numeric',
            month: 'short',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
        }).format(new Date(timestamp));
    } catch {
        return new Date(timestamp).toLocaleString(locale);
    }
}

export function describeTrigger(task: ScheduledTask, locale: string): string {
    if (task.trigger.type === 'once') {
        return formatDateTime(task.trigger.timestamp, task.timezone, locale);
    }
    if (task.trigger.type === 'interval') {
        const minutes = Math.max(1, Math.round(task.trigger.milliseconds / 60_000));
        return `${minutes}m`;
    }
    if (task.trigger.type === 'event') return task.trigger.eventType;
    const preset = detectCronPreset(task.trigger.expression);
    if (preset === 'daily') return t('settings.scheduledTasks.presetDaily');
    if (preset === 'weekdays') return t('settings.scheduledTasks.presetWeekdays');
    if (preset === 'weekly') return t('settings.scheduledTasks.presetWeekly');
    return task.trigger.expression;
}

export function parseWallClock(date: string, time: string, timezone: string): number | null {
    const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    const timeMatch = /^(\d{2}):(\d{2})$/.exec(time);
    if (!dateMatch || !timeMatch) return null;
    return zonedDateTimeToTimestamp(
        {
            year: Number(dateMatch[1]),
            month: Number(dateMatch[2]),
            day: Number(dateMatch[3]),
            hour: Number(timeMatch[1]),
            minute: Number(timeMatch[2]),
            second: 0,
        },
        timezone
    );
}

export function outcomeLabel(run: ScheduledTaskRun): string {
    if (run.outcome === null) return t('settings.scheduledTasks.status.running');
    const key: Record<Exclude<ScheduledTaskRun['outcome'], null>, MessageKey> = {
        completed: 'settings.scheduledTasks.status.completed',
        failed: 'settings.scheduledTasks.status.failed',
        cancelled: 'settings.scheduledTasks.status.cancelled',
        skipped_overlap: 'settings.scheduledTasks.status.skippedOverlap',
        missed: 'settings.scheduledTasks.status.missed',
        skipped_dst: 'settings.scheduledTasks.status.skippedDst',
    };
    return t(key[run.outcome]);
}

export function reasonLabel(run: ScheduledTaskRun): string {
    switch (run.reason) {
        case 'delayed_catch_up':
            return t('settings.scheduledTasks.reason.delayedCatchUp');
        case 'coalesced_while_app_closed':
            return t('settings.scheduledTasks.reason.missedClosed');
        case 'catch_up_grace_expired':
            return t('settings.scheduledTasks.reason.missedExpired');
        case 'previous_run_active':
            return t('settings.scheduledTasks.reason.overlap');
        case 'nonexistent_local_time':
            return t('settings.scheduledTasks.reason.dst');
        case 'interrupted_during_restart':
            return t('settings.scheduledTasks.reason.interrupted');
        default:
            return run.reason || t('settings.scheduledTasks.reason.none');
    }
}
