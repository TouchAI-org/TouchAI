import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reactive } from 'vue';

import type { IntervalTrigger, ScheduledTask } from '@/services/SchedulerService';
import { TaskScheduler } from '@/services/SchedulerService';

const { startBackgroundTaskMock } = vi.hoisted(() => ({ startBackgroundTaskMock: vi.fn() }));

vi.mock('@/services/AgentService', () => ({
    sessionTaskCenter: { startBackgroundTask: startBackgroundTaskMock },
}));

let pendingCompletions: Array<() => void> = [];

function backgroundTask() {
    return {
        completion: new Promise<void>((resolveCompletion) => {
            pendingCompletions.push(() => resolveCompletion());
        }),
    };
}

function releaseBackgroundTasks() {
    for (const release of pendingCompletions) {
        release();
    }
    pendingCompletions = [];
}

function createScheduler() {
    return new TaskScheduler();
}

beforeEach(() => {
    vi.clearAllMocks();
    pendingCompletions = [];
    startBackgroundTaskMock.mockImplementation(async () => backgroundTask());
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('user schedules a repeating task', () => {
    it('user sees the task run on its interval with the saved prompt and model', async () => {
        const scheduler = createScheduler();
        const task = await scheduler.addTask({
            name: 'Daily digest',
            prompt: 'Summarize recent work',
            modelId: 'model-1',
            providerId: 3,
            trigger: { type: 'interval', milliseconds: 1_000 },
        });

        expect(startBackgroundTaskMock).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1_000);

        expect(startBackgroundTaskMock).toHaveBeenCalledWith({
            prompt: 'Summarize recent work',
            modelId: 'model-1',
            providerId: 3,
        });
        expect(scheduler.getTask(task.id)?.lastRunAt).not.toBeNull();

        releaseBackgroundTasks();
        await scheduler.removeTask(task.id);
    });

    it('user sees the next run time scheduled ahead of time', async () => {
        const scheduler = createScheduler();
        const task = await scheduler.addTask({
            name: 'Hourly digest',
            prompt: 'Summarize',
            trigger: { type: 'interval', milliseconds: 60_000 },
        });

        expect(scheduler.getTask(task.id)?.nextRunAt).toBe(Date.now() + 60_000);
        await scheduler.removeTask(task.id);
    });

    it('user sees a disabled task stay quiet and start running once it is enabled', async () => {
        const scheduler = createScheduler();
        const task = await scheduler.addTask({
            name: 'Paused digest',
            prompt: 'Summarize',
            enabled: false,
            trigger: { type: 'interval', milliseconds: 1_000 },
        });

        await vi.advanceTimersByTimeAsync(3_000);
        expect(startBackgroundTaskMock).not.toHaveBeenCalled();
        expect(scheduler.getTask(task.id)?.nextRunAt).toBeNull();

        await scheduler.updateTask(task.id, { enabled: true });
        await vi.advanceTimersByTimeAsync(1_000);

        expect(startBackgroundTaskMock).toHaveBeenCalledTimes(1);

        releaseBackgroundTasks();
        await scheduler.removeTask(task.id);
    });

    it('user does not get two overlapping runs when one run is still going', async () => {
        const scheduler = createScheduler();
        const task = await scheduler.addTask({
            name: 'Overlapping digest',
            prompt: 'Summarize',
            trigger: { type: 'interval', milliseconds: 1_000 },
        });

        await vi.advanceTimersByTimeAsync(1_000);
        expect(startBackgroundTaskMock).toHaveBeenCalledTimes(1);

        // The first run has not finished yet, so the next tick must be skipped.
        await vi.advanceTimersByTimeAsync(1_000);
        expect(startBackgroundTaskMock).toHaveBeenCalledTimes(1);

        releaseBackgroundTasks();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(startBackgroundTaskMock).toHaveBeenCalledTimes(2);

        releaseBackgroundTasks();
        await scheduler.removeTask(task.id);
    });

    it('user sees the old interval stop when they change the schedule', async () => {
        const scheduler = createScheduler();
        const task = await scheduler.addTask({
            name: 'Digest',
            prompt: 'Summarize',
            trigger: { type: 'interval', milliseconds: 1_000 },
        });

        await scheduler.updateTask(task.id, {
            trigger: { type: 'interval', milliseconds: 10_000 },
        });
        await vi.advanceTimersByTimeAsync(1_000);

        expect(startBackgroundTaskMock).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(9_000);
        expect(startBackgroundTaskMock).toHaveBeenCalledTimes(1);

        releaseBackgroundTasks();
        await scheduler.removeTask(task.id);
    });

    it('user sees a removed task never run again', async () => {
        const scheduler = createScheduler();
        const task = await scheduler.addTask({
            name: 'Digest',
            prompt: 'Summarize',
            trigger: { type: 'interval', milliseconds: 1_000 },
        });

        await expect(scheduler.removeTask(task.id)).resolves.toBe(true);
        await vi.advanceTimersByTimeAsync(5_000);

        expect(startBackgroundTaskMock).not.toHaveBeenCalled();
        expect(scheduler.getTask(task.id)).toBeUndefined();
    });

    it('user sees a task that only fires once disable itself after running', async () => {
        const scheduler = createScheduler();
        const task = await scheduler.addTask({
            name: 'One shot',
            prompt: 'Summarize',
            trigger: { type: 'once', timestamp: Date.now() + 1_000 },
        });

        await vi.advanceTimersByTimeAsync(1_000);
        expect(startBackgroundTaskMock).toHaveBeenCalledTimes(1);

        releaseBackgroundTasks();
        await vi.advanceTimersByTimeAsync(0);

        expect(scheduler.getTask(task.id)?.enabled).toBe(false);
        expect(scheduler.getTask(task.id)?.nextRunAt).toBeNull();

        await vi.advanceTimersByTimeAsync(10_000);
        expect(startBackgroundTaskMock).toHaveBeenCalledTimes(1);
    });

    it('user sees a scheduled task still work after the run fails', async () => {
        const scheduler = createScheduler();
        const task = await scheduler.addTask({
            name: 'Fragile digest',
            prompt: 'Summarize',
            trigger: { type: 'interval', milliseconds: 1_000 },
        });
        startBackgroundTaskMock.mockRejectedValueOnce(new Error('model unavailable'));

        await vi.advanceTimersByTimeAsync(1_000);
        expect(startBackgroundTaskMock).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1_000);
        expect(startBackgroundTaskMock).toHaveBeenCalledTimes(2);

        releaseBackgroundTasks();
        await scheduler.removeTask(task.id);
    });

    it('user is told when a schedule is impossible instead of getting a silent task', async () => {
        const scheduler = createScheduler();

        expect(() => scheduler.calculateNextRun({ type: 'interval', milliseconds: 0 })).toThrow(
            'Interval trigger milliseconds must be greater than 0'
        );
        expect(() => scheduler.calculateNextRun({ type: 'once', timestamp: Number.NaN })).toThrow(
            'Once trigger timestamp must be a valid number'
        );
    });

    it('user sees the next run computed for each kind of schedule', () => {
        const scheduler = createScheduler();
        const from = new Date(2026, 4, 22, 10, 30);

        expect(scheduler.calculateNextRun({ type: 'interval', milliseconds: 90_000 }, from)).toBe(
            from.getTime() + 90_000
        );
        expect(scheduler.calculateNextRun({ type: 'cron', expression: '0 9 * * *' }, from)).toBe(
            new Date(2026, 4, 23, 9, 0).getTime()
        );
        expect(
            scheduler.calculateNextRun({ type: 'event', eventType: 'app-start' }, from)
        ).toBeNull();
    });

    it('user sees the saved task snapshot copied instead of a live handle they could mutate', async () => {
        const scheduler = createScheduler();
        const trigger = reactive<IntervalTrigger>({
            type: 'interval',
            milliseconds: 1_000,
        });
        const task = await scheduler.addTask({
            name: 'Daily digest',
            prompt: 'Summarize recent work',
            trigger,
        });

        trigger.milliseconds = 2_000;

        expect(scheduler.getTask(task.id)?.trigger).toEqual({
            type: 'interval',
            milliseconds: 1_000,
        });
        expect(scheduler.getAllTasks().map((item: ScheduledTask) => item.id)).toEqual([task.id]);

        await scheduler.removeTask(task.id);
    });
});
