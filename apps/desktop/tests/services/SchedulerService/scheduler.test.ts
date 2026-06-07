import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reactive } from 'vue';

import type { IntervalTrigger, ScheduleTrigger } from '@/services/SchedulerService';
import { TaskScheduler } from '@/services/SchedulerService';

describe('TaskScheduler', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('accepts reactive trigger objects when adding a scheduled task', async () => {
        const scheduler = new TaskScheduler();
        const trigger = reactive<IntervalTrigger>({
            type: 'interval',
            milliseconds: 1_000,
        });

        const task = await scheduler.addTask({
            name: 'Daily digest',
            prompt: 'Summarize recent work',
            trigger,
        });

        expect(task.trigger).toEqual({
            type: 'interval',
            milliseconds: 1_000,
        });

        trigger.milliseconds = 2_000;

        expect(scheduler.getTask(task.id)?.trigger).toEqual({
            type: 'interval',
            milliseconds: 1_000,
        });

        await scheduler.removeTask(task.id);
    });

    it('accepts reactive trigger objects when updating a scheduled task', async () => {
        const scheduler = new TaskScheduler();
        const task = await scheduler.addTask({
            name: 'Daily digest',
            prompt: 'Summarize recent work',
            trigger: {
                type: 'interval',
                milliseconds: 1_000,
            },
        });
        const trigger = reactive<IntervalTrigger>({
            type: 'interval',
            milliseconds: 2_000,
        });

        const updatedTask = await scheduler.updateTask(task.id, {
            trigger: trigger as ScheduleTrigger,
        });

        expect(updatedTask?.trigger).toEqual({
            type: 'interval',
            milliseconds: 2_000,
        });

        trigger.milliseconds = 3_000;

        expect(scheduler.getTask(task.id)?.trigger).toEqual({
            type: 'interval',
            milliseconds: 2_000,
        });

        await scheduler.removeTask(task.id);
    });
});
