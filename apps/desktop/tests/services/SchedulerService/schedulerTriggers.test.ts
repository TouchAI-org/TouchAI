import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EventTriggerHandler, IntervalTrigger } from '@/services/SchedulerService';
import { TaskScheduler } from '@/services/SchedulerService';
import { eventTriggerRegistry } from '@/services/SchedulerService/eventRegistry';

/**
 * The scheduler decides when a saved prompt runs again. What the user observes is: a task fires
 * at its time, a schedule change takes effect immediately, an event-driven task fires on its
 * event, and a task that cannot be scheduled reports why instead of quietly disappearing.
 *
 * Timers are fake and the agent boundary is mocked; scheduling logic runs for real.
 */

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

beforeEach(() => {
    vi.clearAllMocks();
    pendingCompletions = [];
    startBackgroundTaskMock.mockImplementation(async () => backgroundTask());
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('user schedules a task for a fixed time', () => {
    it('user sees a task scheduled far in the future not run early', async () => {
        const scheduler = new TaskScheduler();
        await scheduler.addTask({
            name: 'Later',
            prompt: 'Summarize',
            trigger: { type: 'once', timestamp: Date.now() + 60_000 },
        });

        await vi.advanceTimersByTimeAsync(59_999);
        expect(startBackgroundTaskMock).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        expect(startBackgroundTaskMock).toHaveBeenCalledTimes(1);

        releaseBackgroundTasks();
    });

    it('user sees a task whose time already passed run immediately instead of never', async () => {
        const scheduler = new TaskScheduler();
        await scheduler.addTask({
            name: 'Overdue',
            prompt: 'Summarize',
            trigger: { type: 'once', timestamp: Date.now() - 5_000 },
        });

        await vi.advanceTimersByTimeAsync(0);
        expect(startBackgroundTaskMock).toHaveBeenCalledTimes(1);

        releaseBackgroundTasks();
    });

    it('user gets the impossible fixed time reported rather than a task that never fires', async () => {
        const scheduler = new TaskScheduler();

        await expect(
            scheduler.addTask({
                name: 'Broken',
                prompt: 'Summarize',
                trigger: { type: 'once', timestamp: Number.NaN },
            })
        ).rejects.toThrow('Once trigger timestamp must be a valid number');
    });

    it('user gets no leftover task when its schedule could not be built', async () => {
        const scheduler = new TaskScheduler();

        await expect(
            scheduler.addTask({
                name: 'Broken',
                prompt: 'Summarize',
                trigger: { type: 'interval', milliseconds: 0 },
            })
        ).rejects.toThrow('Interval trigger milliseconds must be greater than 0');

        // A half-added task would show in the list and never run.
        expect(scheduler.getAllTasks()).toEqual([]);
    });
});

describe('user schedules a task on a cron expression', () => {
    it('user sees a daily cron task scheduled for its next occurrence', async () => {
        const scheduler = new TaskScheduler();
        const task = await scheduler.addTask({
            name: 'Daily',
            prompt: 'Summarize',
            trigger: { type: 'cron', expression: '0 9 * * *' },
        });

        expect(task.nextRunAt).not.toBeNull();
        expect(startBackgroundTaskMock).not.toHaveBeenCalled();
    });

    it('user gets a cron expression that can never match reported as having no next run', () => {
        const scheduler = new TaskScheduler();

        // 30 February never happens, so there is no next occurrence to schedule.
        expect(scheduler.calculateNextRun({ type: 'cron', expression: '0 0 30 2 *' })).toBeNull();
    });

    it('user gets an invalid cron expression rejected instead of silently ignored', () => {
        const scheduler = new TaskScheduler();

        expect(() =>
            scheduler.calculateNextRun({ type: 'cron', expression: 'not a cron' })
        ).toThrow();
    });

    it('user sees a cron task rescheduled after each occurrence', async () => {
        const scheduler = new TaskScheduler();
        const task = await scheduler.addTask({
            name: 'Every minute',
            prompt: 'Summarize',
            trigger: { type: 'cron', expression: '* * * * *' },
        });

        const firstRunAt = scheduler.getTask(task.id)?.nextRunAt;
        await vi.advanceTimersByTimeAsync(60_000);

        expect(startBackgroundTaskMock).toHaveBeenCalledTimes(1);
        // The next occurrence has to be armed before the run, otherwise a cron task fires once.
        expect(scheduler.getTask(task.id)?.nextRunAt).not.toBe(firstRunAt);

        releaseBackgroundTasks();
        await scheduler.removeTask(task.id);
    });

    it('user does not see a removed cron task fire', async () => {
        const scheduler = new TaskScheduler();
        const task = await scheduler.addTask({
            name: 'Every minute',
            prompt: 'Summarize',
            trigger: { type: 'cron', expression: '* * * * *' },
        });

        await scheduler.removeTask(task.id);
        await vi.advanceTimersByTimeAsync(180_000);

        expect(startBackgroundTaskMock).not.toHaveBeenCalled();
    });

    it('user does not see a disabled cron task fire', async () => {
        const scheduler = new TaskScheduler();
        const task = await scheduler.addTask({
            name: 'Every minute',
            prompt: 'Summarize',
            enabled: false,
            trigger: { type: 'cron', expression: '* * * * *' },
        });

        await vi.advanceTimersByTimeAsync(180_000);

        expect(startBackgroundTaskMock).not.toHaveBeenCalled();
        expect(scheduler.getTask(task.id)?.nextRunAt).toBeNull();
    });
});

describe('user schedules a task on an app event', () => {
    let cleanup: () => void;
    let fireEvent: (() => void) | null;

    beforeEach(() => {
        cleanup = vi.fn();
        fireEvent = null;

        const handler: EventTriggerHandler = {
            eventType: 'app-start',
            displayName: 'App start',
            description: 'Fires when the app starts',
            setup: async (_config, callback) => {
                fireEvent = callback;
                return cleanup;
            },
        };
        eventTriggerRegistry.register(handler);
    });

    it('user sees an event task run when its event fires', async () => {
        const scheduler = new TaskScheduler();
        await scheduler.addTask({
            name: 'On start',
            prompt: 'Summarize',
            trigger: { type: 'event', eventType: 'app-start' },
        });

        expect(fireEvent).not.toBeNull();
        fireEvent!();
        await vi.advanceTimersByTimeAsync(0);

        expect(startBackgroundTaskMock).toHaveBeenCalledTimes(1);

        releaseBackgroundTasks();
    });

    it('user sees an event task have no scheduled time because it waits for the event', async () => {
        const scheduler = new TaskScheduler();
        const task = await scheduler.addTask({
            name: 'On start',
            prompt: 'Summarize',
            trigger: { type: 'event', eventType: 'app-start' },
        });

        expect(task.nextRunAt).toBeNull();
    });

    it('user gets the event subscription released when the task is removed', async () => {
        const scheduler = new TaskScheduler();
        const task = await scheduler.addTask({
            name: 'On start',
            prompt: 'Summarize',
            trigger: { type: 'event', eventType: 'app-start' },
        });

        await scheduler.removeTask(task.id);

        // Without the cleanup the subscription would leak and keep firing for a dead task.
        expect(cleanup).toHaveBeenCalled();
    });

    it('user does not see a removed event task fire on its event', async () => {
        const scheduler = new TaskScheduler();
        const task = await scheduler.addTask({
            name: 'On start',
            prompt: 'Summarize',
            trigger: { type: 'event', eventType: 'app-start' },
        });

        const callback = fireEvent;
        await scheduler.removeTask(task.id);
        callback?.();
        await vi.advanceTimersByTimeAsync(0);

        expect(startBackgroundTaskMock).not.toHaveBeenCalled();
    });

    it('user gets an event subscription released when the task was deleted while subscribing', async () => {
        // The subscription is set up asynchronously, so the user can delete the task mid-setup.
        let scheduler: TaskScheduler | null = null;
        eventTriggerRegistry.register({
            eventType: 'slow-setup',
            displayName: 'Slow setup',
            description: 'Resolves after the user deleted the task',
            setup: async () => {
                // The task is already in the list while its subscription is being built.
                const pendingTask = scheduler!.getAllTasks()[0];
                await scheduler!.removeTask(pendingTask!.id);
                return cleanup;
            },
        });

        scheduler = new TaskScheduler();
        await expect(
            scheduler.addTask({
                name: 'On slow',
                prompt: 'Summarize',
                trigger: { type: 'event', eventType: 'slow-setup' },
            })
        ).resolves.toBeDefined();

        // A subscription left behind for a task that no longer exists would keep firing.
        expect(cleanup).toHaveBeenCalled();
        expect(scheduler.getAllTasks()).toEqual([]);
    });

    it('user gets an unknown event type reported instead of a task that never fires', async () => {
        const scheduler = new TaskScheduler();

        await expect(
            scheduler.addTask({
                name: 'On nothing',
                prompt: 'Summarize',
                trigger: { type: 'event', eventType: 'no-such-event' },
            })
        ).rejects.toThrow('Unknown event type: no-such-event');
    });

    it('user sees an event task resubscribe when its event type changes', async () => {
        const scheduler = new TaskScheduler();
        const task = await scheduler.addTask({
            name: 'On start',
            prompt: 'Summarize',
            trigger: { type: 'event', eventType: 'app-start' },
        });

        await scheduler.updateTask(task.id, {
            trigger: { type: 'event', eventType: 'app-start' },
        });

        expect(cleanup).toHaveBeenCalled();

        releaseBackgroundTasks();
    });
});

describe('user edits a saved task', () => {
    it('user gets nothing updated when the task no longer exists', async () => {
        const scheduler = new TaskScheduler();

        await expect(scheduler.updateTask('missing', { name: 'Renamed' })).resolves.toBeUndefined();
    });

    it('user gets the task left untouched when its new schedule is impossible', async () => {
        const scheduler = new TaskScheduler();
        const task = await scheduler.addTask({
            name: 'Digest',
            prompt: 'Summarize',
            trigger: { type: 'interval', milliseconds: 60_000 },
        });

        await expect(
            scheduler.updateTask(task.id, {
                trigger: { type: 'interval', milliseconds: 0 },
            })
        ).rejects.toThrow('Interval trigger milliseconds must be greater than 0');

        // The rejected edit must not leave the task on a broken schedule.
        expect(scheduler.getTask(task.id)?.trigger).toEqual({
            type: 'interval',
            milliseconds: 60_000,
        });

        await scheduler.removeTask(task.id);
    });

    it('user gets nothing removed when the task is already gone', async () => {
        const scheduler = new TaskScheduler();

        await expect(scheduler.removeTask('missing')).resolves.toBe(false);
    });

    it('user sees the prompt change take effect on the next run', async () => {
        const scheduler = new TaskScheduler();
        const task = await scheduler.addTask({
            name: 'Digest',
            prompt: 'Old prompt',
            trigger: { type: 'interval', milliseconds: 1_000 },
        });

        await scheduler.updateTask(task.id, { prompt: 'New prompt' });
        await vi.advanceTimersByTimeAsync(1_000);

        expect(startBackgroundTaskMock).toHaveBeenCalledWith(
            expect.objectContaining({ prompt: 'New prompt' })
        );

        releaseBackgroundTasks();
        await scheduler.removeTask(task.id);
    });

    it('user sees a task switched off stop running and report no next run', async () => {
        const scheduler = new TaskScheduler();
        const task = await scheduler.addTask({
            name: 'Digest',
            prompt: 'Summarize',
            trigger: { type: 'interval', milliseconds: 1_000 },
        });

        await scheduler.updateTask(task.id, { enabled: false });
        await vi.advanceTimersByTimeAsync(5_000);

        expect(startBackgroundTaskMock).not.toHaveBeenCalled();
        expect(scheduler.getTask(task.id)?.nextRunAt).toBeNull();

        await scheduler.removeTask(task.id);
    });
});

describe('user gets a run that cannot overlap or outlive its schedule', () => {
    it('user sees an interval tick ignored when the task was switched off mid-flight', async () => {
        const scheduler = new TaskScheduler();
        const task = await scheduler.addTask({
            name: 'Digest',
            prompt: 'Summarize',
            trigger: { type: 'interval', milliseconds: 1_000 },
        });

        // Disabling clears the timer, but a tick already queued must also refuse to run.
        await scheduler.updateTask(task.id, { enabled: false });
        await vi.advanceTimersByTimeAsync(3_000);

        expect(startBackgroundTaskMock).not.toHaveBeenCalled();

        await scheduler.removeTask(task.id);
    });

    it('user sees an interval tick ignored after the trigger was replaced by another kind', async () => {
        const scheduler = new TaskScheduler();
        const task = await scheduler.addTask({
            name: 'Digest',
            prompt: 'Summarize',
            trigger: { type: 'interval', milliseconds: 1_000 },
        });

        await scheduler.updateTask(task.id, {
            trigger: { type: 'event', eventType: 'app-start' },
        });
        await vi.advanceTimersByTimeAsync(5_000);

        // The old interval handle is gone; nothing may still be firing from it.
        expect(startBackgroundTaskMock).not.toHaveBeenCalled();

        await scheduler.removeTask(task.id);
    });

    it('user sees a stale run not save over a schedule that changed while it ran', async () => {
        const scheduler = new TaskScheduler();
        const task = await scheduler.addTask({
            name: 'Once',
            prompt: 'Summarize',
            trigger: { type: 'once', timestamp: Date.now() + 1_000 },
        });

        await vi.advanceTimersByTimeAsync(1_000);
        expect(startBackgroundTaskMock).toHaveBeenCalledTimes(1);

        // The user reschedules while the run is still in flight.
        await scheduler.updateTask(task.id, {
            trigger: { type: 'interval', milliseconds: 60_000 },
        });

        releaseBackgroundTasks();
        await vi.advanceTimersByTimeAsync(0);

        // The completed once-run must not disable the task the user just rescheduled.
        expect(scheduler.getTask(task.id)?.enabled).toBe(true);
        expect(scheduler.getTask(task.id)?.trigger).toEqual({
            type: 'interval',
            milliseconds: 60_000,
        });

        await scheduler.removeTask(task.id);
    });

    it('user does not see a run start for a task deleted while it was pending', async () => {
        const scheduler = new TaskScheduler();
        const task = await scheduler.addTask({
            name: 'Once',
            prompt: 'Summarize',
            trigger: { type: 'once', timestamp: Date.now() + 1_000 },
        });

        await scheduler.removeTask(task.id);
        await vi.advanceTimersByTimeAsync(1_000);

        expect(startBackgroundTaskMock).not.toHaveBeenCalled();
    });

    it('user sees the next interval run still fire after a failed one', async () => {
        const scheduler = new TaskScheduler();
        const task = await scheduler.addTask({
            name: 'Fragile',
            prompt: 'Summarize',
            trigger: { type: 'interval', milliseconds: 1_000 },
        });
        startBackgroundTaskMock.mockRejectedValueOnce(new Error('model unavailable'));

        await vi.advanceTimersByTimeAsync(1_000);
        await vi.advanceTimersByTimeAsync(1_000);

        expect(startBackgroundTaskMock).toHaveBeenCalledTimes(2);

        releaseBackgroundTasks();
        await scheduler.removeTask(task.id);
    });
});

describe('user keeps a snapshot of their schedule', () => {
    it('user gets a copy of the task so editing the returned object does not change the schedule', async () => {
        const scheduler = new TaskScheduler();
        const task = await scheduler.addTask({
            name: 'Digest',
            prompt: 'Summarize',
            trigger: { type: 'interval', milliseconds: 1_000 },
        });

        task.name = 'Renamed outside';
        (task.trigger as IntervalTrigger).milliseconds = 999_999;

        expect(scheduler.getTask(task.id)?.name).toBe('Digest');
        expect(scheduler.getTask(task.id)?.trigger).toEqual({
            type: 'interval',
            milliseconds: 1_000,
        });

        await scheduler.removeTask(task.id);
    });

    it('user gets every saved task listed', async () => {
        const scheduler = new TaskScheduler();
        const first = await scheduler.addTask({
            name: 'First',
            prompt: 'A',
            trigger: { type: 'event', eventType: 'app-start' },
        });
        const second = await scheduler.addTask({
            name: 'Second',
            prompt: 'B',
            trigger: { type: 'interval', milliseconds: 60_000 },
        });

        expect(scheduler.getAllTasks().map((task) => task.id)).toEqual([first.id, second.id]);

        await scheduler.removeTask(first.id);
        await scheduler.removeTask(second.id);
    });

    it('user gets a task defaulted to enabled when they did not say otherwise', async () => {
        const scheduler = new TaskScheduler();
        const task = await scheduler.addTask({
            name: 'Digest',
            prompt: 'Summarize',
            trigger: { type: 'interval', milliseconds: 60_000 },
        });

        expect(task.enabled).toBe(true);
        expect(task.lastRunAt).toBeNull();

        await scheduler.removeTask(task.id);
    });
});

describe('user asks the scheduler to act on a task that is not there', () => {
    it('user gets no scheduling work done for an unknown task', async () => {
        const scheduler = new TaskScheduler();

        // The UI can call this while a task is being deleted; it must be a no-op, not a crash.
        await expect(scheduler.scheduleTask('missing')).resolves.toBeUndefined();
        expect(scheduler.getAllTasks()).toEqual([]);
    });

    it('user gets no error when an unknown task is unscheduled', () => {
        const scheduler = new TaskScheduler();

        expect(() => scheduler.unscheduleTask('missing')).not.toThrow();
    });

    it('user does not get a run started for an unknown task', async () => {
        const scheduler = new TaskScheduler();

        await scheduler.executeTask('missing');

        expect(startBackgroundTaskMock).not.toHaveBeenCalled();
    });

    it('user does not get a run started for a task that is switched off', async () => {
        const scheduler = new TaskScheduler();
        const task = await scheduler.addTask({
            name: 'Paused',
            prompt: 'Summarize',
            enabled: false,
            trigger: { type: 'interval', milliseconds: 60_000 },
        });

        await scheduler.executeTask(task.id);

        expect(startBackgroundTaskMock).not.toHaveBeenCalled();

        await scheduler.removeTask(task.id);
    });

    it('user does not get a stale run started for a schedule that has since changed', async () => {
        const scheduler = new TaskScheduler();
        const task = await scheduler.addTask({
            name: 'Digest',
            prompt: 'Summarize',
            trigger: { type: 'interval', milliseconds: 60_000 },
        });

        // Version 0 predates the task's current schedule, so a queued tick for it is stale.
        await scheduler.executeTask(task.id, 0);

        expect(startBackgroundTaskMock).not.toHaveBeenCalled();

        await scheduler.removeTask(task.id);
    });

    it('user gets no schedule computed for a trigger kind the app does not know', () => {
        const scheduler = new TaskScheduler();

        expect(scheduler.calculateNextRun({ type: 'unknown' } as never)).toBeNull();
    });

    it('user gets a task with an unknown trigger kind saved but never run', async () => {
        const scheduler = new TaskScheduler();
        const task = await scheduler.addTask({
            name: 'Unknown',
            prompt: 'Summarize',
            trigger: { type: 'unknown' } as never,
        });

        await vi.advanceTimersByTimeAsync(60_000);

        expect(startBackgroundTaskMock).not.toHaveBeenCalled();
        expect(task.nextRunAt).toBeNull();

        await scheduler.removeTask(task.id);
    });

    it('user gets a cron task that can never fire saved without a next run', async () => {
        const scheduler = new TaskScheduler();
        const task = await scheduler.addTask({
            name: 'Never',
            prompt: 'Summarize',
            trigger: { type: 'cron', expression: '0 0 30 2 *' },
        });

        await vi.advanceTimersByTimeAsync(120_000);

        expect(startBackgroundTaskMock).not.toHaveBeenCalled();
        expect(task.nextRunAt).toBeNull();

        await scheduler.removeTask(task.id);
    });
});

describe('user gets a schedule that survives an environment without structuredClone', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('user gets the trigger copied even when the runtime has no structuredClone', async () => {
        vi.stubGlobal('structuredClone', undefined);

        const scheduler = new TaskScheduler();
        const trigger = { type: 'interval' as const, milliseconds: 1_000 };
        const task = await scheduler.addTask({
            name: 'Digest',
            prompt: 'Summarize',
            trigger,
        });

        trigger.milliseconds = 999_999;

        expect(scheduler.getTask(task.id)?.trigger).toEqual({
            type: 'interval',
            milliseconds: 1_000,
        });

        await scheduler.removeTask(task.id);
    });
});
