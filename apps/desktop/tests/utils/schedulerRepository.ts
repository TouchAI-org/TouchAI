import type { ScheduledTask, ScheduledTaskRun, SchedulerRepository } from '@/modules/scheduler';

function clone<T>(value: T): T {
    return structuredClone(value);
}

export class MemorySchedulerRepository implements SchedulerRepository {
    readonly tasks = new Map<string, ScheduledTask>();
    readonly runs = new Map<string, ScheduledTaskRun>();

    seedTask(task: ScheduledTask): void {
        this.tasks.set(task.id, clone(task));
    }

    seedRun(run: ScheduledTaskRun): void {
        this.runs.set(run.id, clone(run));
    }

    async insertTask(task: ScheduledTask): Promise<void> {
        if (this.tasks.has(task.id)) {
            throw new Error('SCHEDULE_ALREADY_EXISTS');
        }
        this.tasks.set(task.id, clone(task));
    }

    async updateTask(task: ScheduledTask): Promise<void> {
        if (!this.tasks.has(task.id)) {
            throw new Error('SCHEDULE_NOT_FOUND');
        }
        this.tasks.set(task.id, clone(task));
    }

    async listTasks(): Promise<ScheduledTask[]> {
        return [...this.tasks.values()]
            .filter((task) => task.deletedAt === null)
            .map((task) => clone(task));
    }

    async findTask(taskId: string): Promise<ScheduledTask | undefined> {
        const task = this.tasks.get(taskId);
        return task && task.deletedAt === null ? clone(task) : undefined;
    }

    async insertRun(run: ScheduledTaskRun): Promise<boolean> {
        const duplicate = [...this.runs.values()].some(
            (entry) =>
                entry.scheduleId === run.scheduleId &&
                entry.scheduleVersion === run.scheduleVersion &&
                entry.scheduledFor === run.scheduledFor
        );
        if (duplicate) return false;
        this.runs.set(run.id, clone(run));
        return true;
    }

    async updateRun(
        runId: string,
        patch: Partial<Omit<ScheduledTaskRun, 'id' | 'scheduleId'>>
    ): Promise<void> {
        const run = this.runs.get(runId);
        if (!run) throw new Error('SCHEDULE_RUN_NOT_FOUND');
        this.runs.set(runId, clone({ ...run, ...patch }));
    }

    async findActiveRun(scheduleId: string): Promise<ScheduledTaskRun | undefined> {
        const run = [...this.runs.values()].find(
            (entry) => entry.scheduleId === scheduleId && entry.outcome === null
        );
        return run ? clone(run) : undefined;
    }

    async listActiveRuns(): Promise<ScheduledTaskRun[]> {
        return [...this.runs.values()]
            .filter((run) => run.outcome === null)
            .map((run) => clone(run));
    }

    async listRuns(scheduleId: string): Promise<ScheduledTaskRun[]> {
        return [...this.runs.values()]
            .filter((run) => run.scheduleId === scheduleId)
            .sort((left, right) => right.scheduledFor - left.scheduledFor)
            .map((run) => clone(run));
    }

    async pruneRuns(scheduleId: string): Promise<void> {
        const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1_000;
        const candidates = [...this.runs.values()]
            .filter((run) => run.scheduleId === scheduleId && run.outcome !== null)
            .sort((left, right) => right.scheduledFor - left.scheduledFor);
        const keep = new Set(candidates.slice(0, 1_000).map((run) => run.id));
        for (const run of candidates) {
            if (run.scheduledFor < cutoff || !keep.has(run.id)) {
                this.runs.delete(run.id);
            }
        }
    }
}

export function createDeferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((nextResolve, nextReject) => {
        resolve = nextResolve;
        reject = nextReject;
    });
    return { promise, resolve, reject };
}
