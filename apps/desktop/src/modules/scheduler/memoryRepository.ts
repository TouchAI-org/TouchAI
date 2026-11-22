import type { ScheduledTask, ScheduledTaskRun, SchedulerRepository } from './types';

function clone<T>(value: T): T {
    if (typeof structuredClone === 'function') {
        return structuredClone(value);
    }
    return JSON.parse(JSON.stringify(value)) as T;
}

/** Runtime fallback for isolated scheduler consumers; production injects SQLite. */
export class MemorySchedulerRepository implements SchedulerRepository {
    private readonly tasks = new Map<string, ScheduledTask>();
    private readonly runs = new Map<string, ScheduledTaskRun>();

    async insertTask(task: ScheduledTask): Promise<void> {
        if (this.tasks.has(task.id)) throw new Error('SCHEDULE_ALREADY_EXISTS');
        this.tasks.set(task.id, clone(task));
    }

    async updateTask(task: ScheduledTask): Promise<void> {
        if (!this.tasks.has(task.id)) throw new Error('SCHEDULE_NOT_FOUND');
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
        const active = [...this.runs.values()].find(
            (run) => run.scheduleId === scheduleId && run.outcome === null
        );
        return active ? clone(active) : undefined;
    }

    async listActiveRuns(): Promise<ScheduledTaskRun[]> {
        return [...this.runs.values()]
            .filter((run) => run.outcome === null)
            .map((run) => clone(run));
    }

    async listRuns(scheduleId: string): Promise<ScheduledTaskRun[]> {
        return [...this.runs.values()]
            .filter((run) => run.scheduleId === scheduleId)
            .sort(
                (left, right) =>
                    right.scheduledFor - left.scheduledFor || right.createdAt - left.createdAt
            )
            .map((run) => clone(run));
    }

    async pruneRuns(scheduleId: string): Promise<void> {
        const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1_000;
        const finished = [...this.runs.values()]
            .filter((run) => run.scheduleId === scheduleId && run.outcome !== null)
            .sort(
                (left, right) =>
                    right.scheduledFor - left.scheduledFor || right.createdAt - left.createdAt
            );
        const retained = new Set(finished.slice(0, 1_000).map((run) => run.id));
        for (const run of finished) {
            if (run.scheduledFor < cutoff || !retained.has(run.id)) {
                this.runs.delete(run.id);
            }
        }
    }
}
