import { performance } from 'node:perf_hooks';

import { MemorySchedulerRepository } from '@tests/utils/schedulerRepository';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type ScheduledTask, type SchedulerCompletion, TaskScheduler } from '@/modules/scheduler';

const HOUR = 60 * 60 * 1_000;
const RECONCILE_BUDGET_MS = 500;
const TRIGGER_OVERHEAD_BUDGET_MS = 100;

function task(index: number, now: number): ScheduledTask {
    return {
        id: `schedule-${index}`,
        name: `Schedule ${index}`,
        prompt: `Prompt ${index}`,
        trigger: { type: 'cron', expression: '0 9 * * *' },
        timezone: 'Asia/Shanghai',
        enabled: true,
        lastRunAt: null,
        nextRunAt: now + HOUR,
        version: 1,
        deletedAt: null,
        createdAt: now - 24 * HOUR,
        updatedAt: now - 24 * HOUR,
    };
}

function scheduler(repository: MemorySchedulerRepository) {
    return new TaskScheduler({
        repository,
        run: () => ({
            backgroundTaskId: crypto.randomUUID(),
            sessionId: null,
            completion: new Promise<SchedulerCompletion>(() => undefined),
        }),
        listen: async () => () => undefined,
        diagnostics: { warn() {}, error() {} },
    });
}

function p95(samples: number[]): number {
    const sorted = [...samples].sort((left, right) => left - right);
    return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-05T08:00:00.000Z'));
});

afterEach(() => {
    vi.useRealTimers();
});

describe.runIf(process.env.SCHEDULER_PERF === '1')(
    'user starts TouchAI with a large schedule collection',
    () => {
        it('user does not wait beyond the reconcile budget for 500 schedules', async () => {
            const samples: number[] = [];
            for (let sample = 0; sample < 10; sample += 1) {
                const repository = new MemorySchedulerRepository();
                for (let index = 0; index < 500; index += 1) {
                    repository.seedTask(task(index, Date.now()));
                }
                const candidate = scheduler(repository);
                const started = performance.now();
                await candidate.initialize();
                samples.push(performance.now() - started);
                candidate.dispose();
            }

            const measured = p95(samples);
            if (process.env.SCHEDULER_PERF_REPORT === '1') {
                process.stdout.write(`reconcile_p95_ms=${measured.toFixed(3)}\n`);
            }
            expect(measured).toBeLessThanOrEqual(RECONCILE_BUDGET_MS);
        });
    }
);

describe.runIf(process.env.SCHEDULER_PERF === '1')('user reaches a due schedule', () => {
    it('user starts the shared background task within the trigger overhead budget', async () => {
        const repository = new MemorySchedulerRepository();
        const candidate = scheduler(repository);
        const samples: number[] = [];
        for (let index = 0; index < 25; index += 1) {
            const saved = await candidate.addTask({
                name: `Due ${index}`,
                prompt: 'Run',
                trigger: { type: 'interval', milliseconds: HOUR },
                timezone: 'UTC',
            });
            candidate.unscheduleTask(saved.id);
            const started = performance.now();
            await candidate.executeTask(saved.id);
            samples.push(performance.now() - started);
        }

        const measured = p95(samples);
        if (process.env.SCHEDULER_PERF_REPORT === '1') {
            process.stdout.write(`trigger_overhead_p95_ms=${measured.toFixed(3)}\n`);
        }
        expect(measured).toBeLessThanOrEqual(TRIGGER_OVERHEAD_BUDGET_MS);
        candidate.dispose();
    });
});
