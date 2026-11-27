import { beforeEach, describe, expect, it } from 'vitest';

import type {
    ScheduledTask,
    ScheduledTaskRun,
    ScheduleTrigger,
} from '@/app/api/scheduler/administration';
import { setLocale } from '@/i18n';
import {
    buildCronExpression,
    describeTrigger,
    detectCronPreset,
    formatDateTime,
    outcomeLabel,
    parseWallClock,
    reasonLabel,
    splitCronTime,
} from '@/views/SettingsView/components/ScheduledTasks/presentation';

function task(trigger: ScheduleTrigger): ScheduledTask {
    return {
        id: 'schedule-1',
        name: 'Scheduled task',
        prompt: 'Run',
        trigger,
        timezone: 'Asia/Shanghai',
        enabled: true,
        lastRunAt: null,
        nextRunAt: null,
        version: 1,
        deletedAt: null,
        createdAt: 1,
        updatedAt: 1,
    };
}

function run(overrides: Partial<ScheduledTaskRun> = {}): ScheduledTaskRun {
    return {
        id: 'run-1',
        scheduleId: 'schedule-1',
        scheduleVersion: 1,
        scheduledFor: 1,
        startedAt: null,
        finishedAt: null,
        outcome: 'completed',
        reason: null,
        backgroundTaskId: null,
        sessionId: null,
        turnId: null,
        createdAt: 1,
        ...overrides,
    };
}

beforeEach(() => {
    setLocale('en-US');
});

describe('user reviews schedule presentation', () => {
    it('user sees recurring presets and cron values without losing the entered time', () => {
        expect(detectCronPreset('0 9 * * *')).toBe('daily');
        expect(detectCronPreset('15 8 * * 1-5')).toBe('weekdays');
        expect(detectCronPreset('30 7 * * 1')).toBe('weekly');
        expect(detectCronPreset('*/5 * * * *')).toBe('custom');

        expect(buildCronExpression('daily', '09:05')).toBe('5 9 * * *');
        expect(buildCronExpression('weekdays', '08:15')).toBe('15 8 * * 1-5');
        expect(buildCronExpression('weekly', '07:30')).toBe('30 7 * * 1');
        expect(buildCronExpression('custom', '10:15')).toBe('15 10 * * *');

        expect(splitCronTime('05 09 * * *')).toEqual({ hour: 9, minute: 5 });
        expect(splitCronTime('09 * * * *')).toBeNull();
        expect(splitCronTime('60 09 * * *')).toBeNull();
        expect(splitCronTime('05 24 * * *')).toBeNull();
    });

    it('user sees every supported trigger as a readable schedule', () => {
        expect(
            describeTrigger(
                task({ type: 'once', timestamp: Date.parse('2026-03-09T01:30:00Z') }),
                'en-US'
            )
        ).toContain('2026');
        expect(describeTrigger(task({ type: 'interval', milliseconds: 30_000 }), 'en-US')).toBe(
            '1m'
        );
        expect(
            describeTrigger(task({ type: 'event', eventType: 'conversation.completed' }), 'en-US')
        ).toBe('conversation.completed');
        expect(describeTrigger(task({ type: 'cron', expression: '0 9 * * *' }), 'en-US')).toBe(
            'Every day'
        );
        expect(describeTrigger(task({ type: 'cron', expression: '0 9 * * 1-5' }), 'en-US')).toBe(
            'Weekdays'
        );
        expect(describeTrigger(task({ type: 'cron', expression: '0 9 * * 1' }), 'en-US')).toBe(
            'Every week'
        );
        expect(describeTrigger(task({ type: 'cron', expression: '*/5 * * * *' }), 'en-US')).toBe(
            '*/5 * * * *'
        );
    });

    it('user gets a localized time or a clear fallback for unsupported display input', () => {
        expect(formatDateTime(null, 'Asia/Shanghai', 'en-US')).toBe('Never');
        expect(
            formatDateTime(Date.parse('2026-03-09T01:30:00Z'), 'Asia/Shanghai', 'en-US')
        ).toContain('2026');
        expect(formatDateTime(0, 'Invalid/Timezone', 'en-US')).not.toHaveLength(0);
    });

    it('user gets a timestamp only for an existing valid local date and time', () => {
        expect(parseWallClock('2026-03-09', '09:30', 'Asia/Shanghai')).toBe(
            Date.parse('2026-03-09T01:30:00Z')
        );
        expect(parseWallClock('03/09/2026', '09:30', 'Asia/Shanghai')).toBeNull();
        expect(parseWallClock('2026-03-09', '9:30', 'Asia/Shanghai')).toBeNull();
        expect(parseWallClock('2026-03-08', '02:30', 'America/New_York')).toBeNull();
        expect(parseWallClock('2026-03-09', '09:30', 'Invalid/Timezone')).toBeNull();
    });
});

describe('user reviews run history labels', () => {
    it('user sees every run outcome and reason in the selected locale', () => {
        expect(outcomeLabel(run({ outcome: null }))).toBe('Running');
        expect(outcomeLabel(run({ outcome: 'completed' }))).toBe('Completed');
        expect(outcomeLabel(run({ outcome: 'failed' }))).toBe('Failed');
        expect(outcomeLabel(run({ outcome: 'cancelled' }))).toBe('Cancelled');
        expect(outcomeLabel(run({ outcome: 'skipped_overlap' }))).toBe('Skipped overlap');
        expect(outcomeLabel(run({ outcome: 'missed' }))).toBe('Missed');
        expect(outcomeLabel(run({ outcome: 'skipped_dst' }))).toBe('Skipped for DST');

        expect(reasonLabel(run({ reason: 'delayed_catch_up' }))).toBe('Delayed catch-up');
        expect(reasonLabel(run({ reason: 'coalesced_while_app_closed' }))).toBe(
            'Coalesced while app was closed'
        );
        expect(reasonLabel(run({ reason: 'catch_up_grace_expired' }))).toBe(
            'Catch-up window expired'
        );
        expect(reasonLabel(run({ reason: 'previous_run_active' }))).toBe(
            'Previous run still active'
        );
        expect(reasonLabel(run({ reason: 'nonexistent_local_time' }))).toBe(
            'Local time does not exist'
        );
        expect(reasonLabel(run({ reason: 'interrupted_during_restart' }))).toBe(
            'Run interrupted by app restart'
        );
        expect(reasonLabel(run({ reason: 'provider rejected request' }))).toBe(
            'provider rejected request'
        );
        expect(reasonLabel(run({ reason: null }))).toBe('—');
    });
});
