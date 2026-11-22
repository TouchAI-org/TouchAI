import { createDeferred, MemorySchedulerRepository } from '@tests/utils/schedulerRepository';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    type ScheduledTask,
    type ScheduledTaskRun,
    type SchedulerCompletion,
    TaskScheduler,
    zonedDateTimeToTimestamp,
} from '@/modules/scheduler';

const DAY = 24 * 60 * 60 * 1_000;

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
    const now = Date.now();
    return {
        id: 'schedule-1',
        name: 'Daily digest',
        prompt: 'Summarize my day',
        trigger: { type: 'cron', expression: '0 9 * * *' },
        timezone: 'UTC',
        modelId: 'model-1',
        providerId: 7,
        enabled: true,
        lastRunAt: null,
        nextRunAt: now + 60_000,
        version: 1,
        deletedAt: null,
        createdAt: now - DAY,
        updatedAt: now - DAY,
        ...overrides,
    };
}

function run(overrides: Partial<ScheduledTaskRun> = {}): ScheduledTaskRun {
    const now = Date.now();
    return {
        id: crypto.randomUUID(),
        scheduleId: 'schedule-1',
        scheduleVersion: 1,
        scheduledFor: now,
        startedAt: now,
        finishedAt: null,
        outcome: null,
        reason: null,
        backgroundTaskId: null,
        sessionId: null,
        turnId: null,
        createdAt: now,
        ...overrides,
    };
}

function createHarness(input: { repository?: MemorySchedulerRepository } = {}) {
    const repository = input.repository ?? new MemorySchedulerRepository();
    const executions: Array<{
        input: { prompt: string; modelId?: string; providerId?: number };
        finish(value: SchedulerCompletion): void;
        reject(error: unknown): void;
    }> = [];
    const notifications: string[] = [];
    const scheduler = new TaskScheduler({
        repository,
        run: async (runInput) => {
            const completion = createDeferred<SchedulerCompletion>();
            executions.push({
                input: runInput,
                finish: completion.resolve,
                reject: completion.reject,
            });
            return {
                backgroundTaskId: `background-${executions.length}`,
                sessionId: 40 + executions.length,
                completion: completion.promise,
            };
        },
        listen: async () => () => undefined,
        diagnostics: { warn() {}, error() {} },
        notifyFailure: async ({ scheduleName }) => {
            notifications.push(scheduleName);
        },
    });
    return { scheduler, repository, executions, notifications };
}

class BlockingActiveRunRepository extends MemorySchedulerRepository {
    private readonly lookupStarted = createDeferred<void>();
    private readonly releaseLookup = createDeferred<void>();
    readonly activeLookupStarted = this.lookupStarted.promise;

    releaseActiveLookup(): void {
        this.releaseLookup.resolve(undefined);
    }

    async findActiveRun(scheduleId: string) {
        this.lookupStarted.resolve(undefined);
        await this.releaseLookup.promise;
        return super.findActiveRun(scheduleId);
    }
}

async function finishAll(executions: ReturnType<typeof createHarness>['executions']) {
    for (const [index, execution] of executions.entries()) {
        execution.finish({
            outcome: 'completed',
            sessionId: 40 + index + 1,
            turnId: 900 + index,
            errorSummary: null,
        });
    }
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-05T08:00:00.000Z'));
});

afterEach(() => {
    vi.useRealTimers();
});

describe('user restarts the desktop app with saved schedules', () => {
    it('user sees a saved cron schedule keep its next run across restart', async () => {
        const first = createHarness();
        const saved = await first.scheduler.addTask({
            name: 'Morning digest',
            prompt: 'Summarize',
            trigger: { type: 'cron', expression: '0 9 * * *' },
            timezone: 'UTC',
        });
        first.scheduler.dispose();

        vi.setSystemTime(new Date('2026-01-05T08:30:00.000Z'));
        const second = createHarness({ repository: first.repository });
        await second.scheduler.initialize();

        expect(second.scheduler.getTask(saved.id)).toMatchObject({
            id: saved.id,
            nextRunAt: Date.parse('2026-01-05T09:00:00.000Z'),
        });
        second.scheduler.dispose();
    });

    it('user gets an interrupted run marked failed without repeating its occurrence', async () => {
        const repository = new MemorySchedulerRepository();
        repository.seedTask(task());
        repository.seedRun(
            run({
                scheduledFor: Date.parse('2026-01-05T07:00:00.000Z'),
                reason: 'started before shutdown',
            })
        );
        const harness = createHarness({ repository });

        await harness.scheduler.initialize();
        await harness.scheduler.initialize();

        const runs = await harness.scheduler.getRuns('schedule-1');
        expect(runs).toHaveLength(1);
        expect(runs[0]).toMatchObject({
            outcome: 'failed',
            reason: expect.stringContaining('interrupted'),
        });
        expect(harness.executions).toHaveLength(0);
    });
});

describe('user returns after a one-time task becomes due', () => {
    it('user sees a one-time task run once and marked delayed inside the catch-up grace', async () => {
        const repository = new MemorySchedulerRepository();
        repository.seedTask(
            task({
                trigger: {
                    type: 'once',
                    timestamp: Date.parse('2026-01-05T07:30:00.000Z'),
                },
                nextRunAt: Date.parse('2026-01-05T07:30:00.000Z'),
            })
        );
        const harness = createHarness({ repository });

        await harness.scheduler.initialize();
        await vi.waitFor(() => expect(harness.executions).toHaveLength(1));
        await finishAll(harness.executions);
        await vi.runOnlyPendingTimersAsync();

        expect(await harness.scheduler.getRuns('schedule-1')).toMatchObject([
            {
                outcome: 'completed',
                reason: 'delayed_catch_up',
                scheduledFor: Date.parse('2026-01-05T07:30:00.000Z'),
            },
        ]);
    });

    it('user sees a one-time task beyond the grace window recorded as missed', async () => {
        const repository = new MemorySchedulerRepository();
        repository.seedTask(
            task({
                trigger: {
                    type: 'once',
                    timestamp: Date.parse('2026-01-04T06:59:59.999Z'),
                },
                nextRunAt: Date.parse('2026-01-04T06:59:59.999Z'),
            })
        );
        const harness = createHarness({ repository });

        await harness.scheduler.initialize();

        expect(harness.executions).toHaveLength(0);
        expect(await harness.scheduler.getRuns('schedule-1')).toMatchObject([
            {
                outcome: 'missed',
                reason: 'catch_up_grace_expired',
            },
        ]);
    });
});

describe('user returns after recurring occurrences were missed', () => {
    it('user sees multiple missed recurring occurrences coalesced into one history entry', async () => {
        const repository = new MemorySchedulerRepository();
        repository.seedTask(
            task({
                nextRunAt: Date.parse('2026-01-01T09:00:00.000Z'),
                lastRunAt: Date.parse('2025-12-31T09:00:00.000Z'),
            })
        );
        const harness = createHarness({ repository });

        await harness.scheduler.initialize();

        expect(harness.executions).toHaveLength(0);
        const runs = await harness.scheduler.getRuns('schedule-1');
        expect(runs).toHaveLength(1);
        expect(runs[0]).toMatchObject({
            outcome: 'missed',
            reason: 'coalesced_while_app_closed',
        });
        expect(harness.scheduler.getTask('schedule-1')?.nextRunAt).toBeGreaterThan(Date.now());
    });
});

describe('user already has a scheduled run in progress', () => {
    it('user sees an overlapping occurrence recorded instead of silently lost', async () => {
        const harness = createHarness();
        const saved = await harness.scheduler.addTask({
            name: 'Minute check',
            prompt: 'Check',
            trigger: { type: 'cron', expression: '* * * * *' },
            timezone: 'UTC',
        });
        harness.repository.seedRun(
            run({
                scheduleId: saved.id,
                scheduleVersion: saved.version,
                scheduledFor: Date.now(),
            })
        );

        await vi.advanceTimersByTimeAsync(60_000);

        expect(harness.executions).toHaveLength(0);
        expect(await harness.scheduler.getRuns(saved.id)).toContainEqual(
            expect.objectContaining({ outcome: 'skipped_overlap' })
        );
    });
});

describe('user changes a schedule while its task is running', () => {
    it('user edits a schedule as its run starts without losing the edit from later runs', async () => {
        const repository = new BlockingActiveRunRepository();
        const harness = createHarness({ repository });
        const saved = await harness.scheduler.addTask({
            name: 'Check',
            prompt: 'Old prompt',
            trigger: { type: 'interval', milliseconds: 60_000 },
            timezone: 'UTC',
        });
        harness.scheduler.unscheduleTask(saved.id);

        const firing = harness.scheduler.executeTask(saved.id);
        await repository.activeLookupStarted;
        const edit = harness.scheduler.updateTask(saved.id, { prompt: 'Edited prompt' });
        await Promise.resolve();
        repository.releaseActiveLookup();
        await Promise.all([firing, edit]);

        expect(harness.executions[0]?.input.prompt).toBe('Old prompt');
        expect(repository.tasks.get(saved.id)).toMatchObject({
            prompt: 'Edited prompt',
            version: 2,
        });
        expect(harness.scheduler.getTask(saved.id)).toMatchObject({
            prompt: 'Edited prompt',
            version: 2,
        });

        harness.executions[0]!.finish({
            outcome: 'completed',
            sessionId: 41,
            turnId: 901,
            errorSummary: null,
        });
        await vi.advanceTimersByTimeAsync(0);
    });

    it('user sees the active run keep its prompt while the edit applies to the next run', async () => {
        const harness = createHarness();
        const saved = await harness.scheduler.addTask({
            name: 'Check',
            prompt: 'Old prompt',
            trigger: { type: 'cron', expression: '* * * * *' },
            timezone: 'UTC',
        });

        await vi.advanceTimersByTimeAsync(60_000);
        await vi.waitFor(() => expect(harness.executions).toHaveLength(1));
        expect(harness.executions[0]!.input.prompt).toBe('Old prompt');

        await harness.scheduler.updateTask(saved.id, { prompt: 'New prompt' });
        harness.executions[0]!.finish({
            outcome: 'completed',
            sessionId: 41,
            turnId: 901,
            errorSummary: null,
        });
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(60_000);

        expect(harness.executions[1]!.input.prompt).toBe('New prompt');
    });

    it('user sees pause stop future occurrences without cancelling the active run', async () => {
        const harness = createHarness();
        const saved = await harness.scheduler.addTask({
            name: 'Check',
            prompt: 'Keep running',
            trigger: { type: 'cron', expression: '* * * * *' },
            timezone: 'UTC',
        });

        await vi.advanceTimersByTimeAsync(60_000);
        await vi.waitFor(() => expect(harness.executions).toHaveLength(1));
        await harness.scheduler.updateTask(saved.id, { enabled: false });
        harness.executions[0]!.finish({
            outcome: 'completed',
            sessionId: 41,
            turnId: 901,
            errorSummary: null,
        });
        await vi.advanceTimersByTimeAsync(120_000);

        expect(harness.executions).toHaveLength(1);
        expect((await harness.scheduler.getRuns(saved.id))[0]?.outcome).toBe('completed');
    });

    it('user sees a deleted schedule keep its active run history and stop future runs', async () => {
        const harness = createHarness();
        const saved = await harness.scheduler.addTask({
            name: 'Check',
            prompt: 'Finish current',
            trigger: { type: 'cron', expression: '* * * * *' },
            timezone: 'UTC',
        });

        await vi.advanceTimersByTimeAsync(60_000);
        await vi.waitFor(() => expect(harness.executions).toHaveLength(1));
        await harness.scheduler.removeTask(saved.id);
        harness.executions[0]!.finish({
            outcome: 'completed',
            sessionId: 41,
            turnId: 901,
            errorSummary: null,
        });
        await vi.advanceTimersByTimeAsync(120_000);

        expect(harness.executions).toHaveLength(1);
        expect(await harness.scheduler.getRuns(saved.id)).toMatchObject([{ outcome: 'completed' }]);
        expect(harness.repository.tasks.get(saved.id)?.deletedAt).not.toBeNull();
    });

    it('user can edit a paused one-time task after its original time without silently rescheduling it', async () => {
        const harness = createHarness();
        const saved = await harness.scheduler.addTask({
            name: 'One time',
            prompt: 'Old prompt',
            trigger: {
                type: 'once',
                timestamp: Date.parse('2026-01-05T09:00:00.000Z'),
            },
            timezone: 'UTC',
        });
        await harness.scheduler.updateTask(saved.id, { enabled: false });
        vi.setSystemTime(new Date('2026-01-05T10:00:00.000Z'));

        const updated = await harness.scheduler.updateTask(saved.id, {
            prompt: 'New prompt',
        });

        expect(updated).toMatchObject({
            prompt: 'New prompt',
            enabled: false,
            nextRunAt: null,
            version: 3,
        });
        expect(harness.executions).toHaveLength(0);
    });
});

describe('user reviews failed scheduled runs', () => {
    it('user sees the background task, conversation, turn, and one coalesced notification', async () => {
        const harness = createHarness();
        const saved = await harness.scheduler.addTask({
            name: 'Fragile check',
            prompt: 'Run',
            trigger: { type: 'cron', expression: '* * * * *' },
            timezone: 'UTC',
        });

        await vi.advanceTimersByTimeAsync(60_000);
        await vi.waitFor(() => expect(harness.executions).toHaveLength(1));
        harness.executions[0]!.finish({
            outcome: 'failed',
            sessionId: 55,
            turnId: 77,
            errorSummary: 'Provider rejected the request',
        });
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(60_000);
        harness.executions[1]!.finish({
            outcome: 'failed',
            sessionId: 56,
            turnId: 78,
            errorSummary: 'Provider rejected the request again',
        });
        await vi.advanceTimersByTimeAsync(0);

        const runs = await harness.scheduler.getRuns(saved.id);
        expect(runs[0]).toMatchObject({
            outcome: 'failed',
            sessionId: 56,
            turnId: 78,
            reason: 'Provider rejected the request again',
        });
        expect(harness.notifications).toEqual(['Fragile check']);
    });
});

describe('user reviews long-running schedule history', () => {
    it('user sees only the newest 1,000 retained runs while old records are pruned', async () => {
        const repository = new MemorySchedulerRepository();
        const harness = createHarness({ repository });
        const now = Date.now();
        for (let index = 0; index < 1_002; index += 1) {
            await repository.insertRun(
                run({
                    id: `run-${index}`,
                    scheduledFor: now - index * 60_000,
                    finishedAt: now - index * 60_000,
                    outcome: 'completed',
                })
            );
        }
        await repository.insertRun(
            run({
                id: 'expired-run',
                scheduledFor: now - 91 * DAY,
                finishedAt: now - 91 * DAY,
                outcome: 'completed',
            })
        );

        await repository.pruneRuns('schedule-1');

        expect(await harness.scheduler.getRuns('schedule-1')).toHaveLength(1_000);
        expect(repository.runs.has('expired-run')).toBe(false);
        expect(repository.runs.has('run-0')).toBe(true);
        expect(repository.runs.has('run-1001')).toBe(false);
    });
});

describe('user enters an invalid schedule', () => {
    it.each([
        {
            label: 'invalid cron',
            trigger: { type: 'cron' as const, expression: 'not cron' },
            timezone: 'UTC',
        },
        {
            label: 'past one-time date',
            trigger: {
                type: 'once' as const,
                timestamp: Date.parse('2026-01-05T07:59:59.000Z'),
            },
            timezone: 'UTC',
        },
        {
            label: 'invalid timezone',
            trigger: { type: 'cron' as const, expression: '0 9 * * *' },
            timezone: 'Mars/Olympus',
        },
    ])('user gets a recoverable error and no saved task for $label', async (input) => {
        const harness = createHarness();

        await expect(
            harness.scheduler.addTask({
                name: 'Broken',
                prompt: 'Summarize',
                trigger: input.trigger,
                timezone: input.timezone,
            })
        ).rejects.toMatchObject({ code: 'SCHEDULE_INVALID_INPUT' });

        expect(harness.scheduler.getAllTasks()).toEqual([]);
        expect(harness.repository.tasks.size).toBe(0);
    });
});

describe('user schedules across daylight-saving transitions', () => {
    it('user is blocked from choosing a nonexistent spring-forward local time', () => {
        expect(
            zonedDateTimeToTimestamp(
                {
                    year: 2026,
                    month: 3,
                    day: 8,
                    hour: 2,
                    minute: 30,
                    second: 0,
                },
                'America/New_York'
            )
        ).toBeNull();
    });

    it('user gets one deterministic occurrence for a duplicated fall-back local time', () => {
        expect(
            zonedDateTimeToTimestamp(
                {
                    year: 2026,
                    month: 11,
                    day: 1,
                    hour: 1,
                    minute: 30,
                    second: 0,
                },
                'America/New_York'
            )
        ).toBe(Date.parse('2026-11-01T05:30:00.000Z'));
    });

    it('user sees a nonexistent spring-forward time recorded as skipped and the next valid time kept', async () => {
        const repository = new MemorySchedulerRepository();
        repository.seedTask(
            task({
                timezone: 'America/New_York',
                trigger: { type: 'cron', expression: '30 2 * * *' },
                lastRunAt: Date.parse('2026-03-07T07:30:00.000Z'),
                nextRunAt: Date.parse('2026-03-09T06:30:00.000Z'),
            })
        );
        vi.setSystemTime(new Date('2026-03-08T08:00:00.000Z'));
        const harness = createHarness({ repository });

        await harness.scheduler.initialize();

        expect(await harness.scheduler.getRuns('schedule-1')).toContainEqual(
            expect.objectContaining({
                outcome: 'skipped_dst',
                scheduledFor: Date.parse('2026-03-08T07:30:00.000Z'),
            })
        );
        expect(harness.scheduler.getTask('schedule-1')?.nextRunAt).toBe(
            Date.parse('2026-03-09T06:30:00.000Z')
        );
        expect(harness.executions).toHaveLength(0);
    });

    it('user sees no skipped DST occurrence for time spent paused across the gap', async () => {
        vi.setSystemTime(new Date('2026-03-08T04:00:00.000Z'));
        const harness = createHarness();
        const saved = await harness.scheduler.addTask({
            name: 'Pause across spring forward',
            prompt: 'Run',
            timezone: 'America/New_York',
            trigger: { type: 'cron', expression: '30 2 * * *' },
        });

        await harness.scheduler.updateTask(saved.id, { enabled: false });
        vi.setSystemTime(new Date('2026-03-08T07:30:00.000Z'));
        await harness.scheduler.updateTask(saved.id, { enabled: true });
        await vi.advanceTimersByTimeAsync(23 * 60 * 60 * 1_000);

        expect(await harness.scheduler.getRuns(saved.id)).not.toContainEqual(
            expect.objectContaining({ outcome: 'skipped_dst' })
        );
    });

    it('user sees a duplicated fall-back wall time execute only once', async () => {
        vi.setSystemTime(new Date('2026-11-01T04:00:00.000Z'));
        const harness = createHarness();
        const saved = await harness.scheduler.addTask({
            name: 'One thirty',
            prompt: 'Run once',
            timezone: 'America/New_York',
            trigger: { type: 'cron', expression: '30 1 * * *' },
        });

        await vi.advanceTimersByTimeAsync(90 * 60_000);
        await vi.waitFor(() => expect(harness.executions).toHaveLength(1));
        harness.executions[0]!.finish({
            outcome: 'completed',
            sessionId: 41,
            turnId: 901,
            errorSummary: null,
        });
        await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);

        expect(harness.executions).toHaveLength(1);
        expect(await harness.scheduler.getRuns(saved.id)).toHaveLength(1);
    });
});
