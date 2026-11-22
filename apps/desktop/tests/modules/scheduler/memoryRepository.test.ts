import { describe, expect, it, vi } from 'vitest';

import { type ScheduledTask, type ScheduledTaskRun } from '@/modules/scheduler';
import { MemorySchedulerRepository } from '@/modules/scheduler/memoryRepository';

const DAY = 24 * 60 * 60 * 1_000;
const now = Date.now();

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
    return {
        id: 'schedule-1',
        name: 'Daily digest',
        prompt: 'Summarize',
        trigger: { type: 'cron', expression: '0 9 * * *' },
        timezone: 'UTC',
        enabled: true,
        lastRunAt: null,
        nextRunAt: now + 60_000,
        version: 1,
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
        ...overrides,
    };
}

function run(overrides: Partial<ScheduledTaskRun> = {}): ScheduledTaskRun {
    return {
        id: 'run-1',
        scheduleId: 'schedule-1',
        scheduleVersion: 1,
        scheduledFor: now,
        startedAt: now,
        finishedAt: now,
        outcome: 'completed',
        reason: null,
        backgroundTaskId: null,
        sessionId: null,
        turnId: null,
        createdAt: now,
        ...overrides,
    };
}

describe('user relies on the in-memory scheduler repository', () => {
    it('user gets copies of visible tasks and clear errors for conflicting writes', async () => {
        const repository = new MemorySchedulerRepository();
        await repository.insertTask(task());
        await repository.insertTask(task({ id: 'schedule-deleted', deletedAt: now }));

        await expect(repository.insertTask(task())).rejects.toThrow('SCHEDULE_ALREADY_EXISTS');
        await expect(
            repository.updateTask(task({ id: 'missing', prompt: 'Changed' }))
        ).rejects.toThrow('SCHEDULE_NOT_FOUND');

        const visible = await repository.listTasks();
        visible[0]!.prompt = 'Mutated by caller';
        expect(await repository.findTask('schedule-1')).toMatchObject({
            prompt: 'Summarize',
        });
        expect(await repository.findTask('schedule-deleted')).toBeUndefined();
    });

    it('user gets the newest active and retained history in a stable order', async () => {
        const repository = new MemorySchedulerRepository();
        await repository.insertTask(task());
        await repository.insertRun(
            run({ id: 'older', scheduledFor: now - 2_000, createdAt: now - 2_000 })
        );
        await repository.insertRun(
            run({ id: 'newer', scheduledFor: now - 1_000, createdAt: now - 1_000 })
        );
        await repository.insertRun(
            run({
                id: 'active',
                scheduledFor: now,
                outcome: null,
                finishedAt: null,
            })
        );

        expect(
            await repository.insertRun(run({ id: 'duplicate', scheduledFor: now - 2_000 }))
        ).toBe(false);
        expect((await repository.findActiveRun('schedule-1'))?.id).toBe('active');
        expect((await repository.listActiveRuns()).map((entry) => entry.id)).toEqual(['active']);
        expect((await repository.listRuns('schedule-1')).map((entry) => entry.id)).toEqual([
            'active',
            'newer',
            'older',
        ]);

        await repository.updateRun('older', {
            finishedAt: now,
            outcome: 'failed',
            reason: 'provider failed',
            backgroundTaskId: 'background-1',
            sessionId: 10,
            turnId: 20,
        });
        expect(
            (await repository.listRuns('schedule-1')).find((entry) => entry.id === 'older')
        ).toMatchObject({
            outcome: 'failed',
            reason: 'provider failed',
            sessionId: 10,
            turnId: 20,
        });
        await expect(repository.updateRun('missing', { reason: 'ignored' })).rejects.toThrow(
            'SCHEDULE_RUN_NOT_FOUND'
        );
    });

    it('user sees expired and overflow history pruned while active work is retained', async () => {
        const repository = new MemorySchedulerRepository();
        await repository.insertTask(task());
        await repository.insertRun(
            run({ id: 'expired-active', scheduledFor: now - 100 * DAY, outcome: null })
        );
        await repository.insertRun(run({ id: 'expired-finished', scheduledFor: now - 100 * DAY }));
        for (let index = 0; index < 1_001; index += 1) {
            await repository.insertRun(
                run({
                    id: `history-${index}`,
                    scheduledFor: now - index * 1_000,
                    createdAt: now - index * 1_000,
                })
            );
        }

        await repository.pruneRuns('schedule-1');

        expect(await repository.listRuns('schedule-1')).toHaveLength(1_001);
        expect(
            (await repository.listRuns('schedule-1')).filter((entry) => entry.outcome !== null)
        ).toHaveLength(1_000);
        expect((await repository.listActiveRuns()).map((entry) => entry.id)).toEqual([
            'expired-active',
        ]);
        expect(
            (await repository.listRuns('schedule-1')).some((entry) => entry.id === 'history-1000')
        ).toBe(false);
    });

    it('user gets task copies even when the runtime lacks structured cloning', async () => {
        vi.stubGlobal('structuredClone', undefined);
        try {
            const repository = new MemorySchedulerRepository();
            await repository.insertTask(task());
            await repository.updateTask(task({ prompt: 'Updated' }));
            expect(await repository.listTasks()).toMatchObject([{ prompt: 'Updated' }]);
        } finally {
            vi.unstubAllGlobals();
        }
    });
});
