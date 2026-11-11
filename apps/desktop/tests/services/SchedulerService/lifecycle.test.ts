import { TaskScheduler } from '@services/SchedulerService/scheduler';
import type { ScheduleTrigger } from '@services/SchedulerService/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-10T10:00:00Z'));
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
});

const triggers: ScheduleTrigger[] = [
    { type: 'interval', milliseconds: 60_000 },
    { type: 'once', timestamp: Date.parse('2026-11-10T11:00:00Z') },
    { type: 'cron', expression: '0 * * * *' },
];

describe('user owns one scheduled trigger per task', () => {
    it.each(triggers)(
        'user unschedules a pending $type registration and no timer survives',
        async (trigger) => {
            const scheduler = new TaskScheduler();
            const task = await scheduler.addTask({ name: 'Lifecycle', prompt: 'Fixture', trigger });
            const pending = scheduler.scheduleTask(task.id);

            scheduler.unscheduleTask(task.id);
            await pending;

            expect(scheduler.getTask(task.id)?.nextRunAt).toBeNull();
            expect(vi.getTimerCount()).toBe(0);
            await scheduler.removeTask(task.id);
        }
    );

    it('user replaces a trigger concurrently and removing the task releases every timer', async () => {
        const scheduler = new TaskScheduler();
        const task = await scheduler.addTask({
            name: 'Lifecycle',
            prompt: 'Fixture',
            trigger: triggers[0]!,
        });

        await Promise.all([scheduler.scheduleTask(task.id), scheduler.scheduleTask(task.id)]);
        await scheduler.removeTask(task.id);

        expect(scheduler.getAllTasks()).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
    });
});
