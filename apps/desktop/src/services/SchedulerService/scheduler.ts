// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { Cron } from 'croner';

import { sessionTaskCenter } from '@/services/AgentService';

import { eventTriggerRegistry } from './eventRegistry';
import type { ScheduledTask, ScheduleTrigger } from './types';

type TimerHandle = ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>;

interface TimerBinding {
    kind: 'timeout' | 'interval';
    handle: TimerHandle;
}

export interface CreateScheduledTaskInput {
    name: string;
    prompt: string;
    trigger: ScheduleTrigger;
    modelId?: string;
    providerId?: number;
    enabled?: boolean;
}

export interface UpdateScheduledTaskInput {
    name?: string;
    prompt?: string;
    trigger?: ScheduleTrigger;
    modelId?: string;
    providerId?: number;
    enabled?: boolean;
}

function cloneValue<T>(value: T): T {
    if (typeof structuredClone === 'function') {
        return structuredClone(value);
    }

    return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * 定时任务调度器。
 *
 * 当前阶段先以内存态维护任务与调度句柄，数据库持久化留到 Part 2 补齐。
 */
export class TaskScheduler {
    private readonly tasks = new Map<string, ScheduledTask>();
    private readonly timers = new Map<string, TimerBinding>();
    private readonly eventCleanups = new Map<string, () => void>();
    private readonly runningTasks = new Set<string>();
    private readonly scheduleVersions = new Map<string, number>();

    async addTask(input: CreateScheduledTaskInput): Promise<ScheduledTask> {
        const now = Date.now();
        const task: ScheduledTask = {
            id: crypto.randomUUID(),
            name: input.name,
            prompt: input.prompt,
            trigger: cloneValue(input.trigger),
            modelId: input.modelId,
            providerId: input.providerId,
            enabled: input.enabled ?? true,
            lastRunAt: null,
            nextRunAt: null,
            createdAt: now,
            updatedAt: now,
        };

        this.tasks.set(task.id, task);

        try {
            await this.saveTask(task);
            await this.scheduleTask(task.id);
            return cloneValue(task);
        } catch (error) {
            this.unscheduleTask(task.id);
            this.tasks.delete(task.id);
            this.runningTasks.delete(task.id);
            this.scheduleVersions.delete(task.id);
            await this.deleteTask(task.id);
            throw error;
        }
    }

    getAllTasks(): ScheduledTask[] {
        return Array.from(this.tasks.values()).map((task) => cloneValue(task));
    }

    getTask(taskId: string): ScheduledTask | undefined {
        const task = this.tasks.get(taskId);
        return task ? cloneValue(task) : undefined;
    }

    async updateTask(
        taskId: string,
        updates: UpdateScheduledTaskInput
    ): Promise<ScheduledTask | undefined> {
        const existingTask = this.tasks.get(taskId);
        if (!existingTask) {
            return undefined;
        }

        const previousTask = cloneValue(existingTask);
        const nextTask: ScheduledTask = {
            ...existingTask,
            ...updates,
            trigger: updates.trigger
                ? cloneValue(updates.trigger)
                : cloneValue(existingTask.trigger),
            updatedAt: Date.now(),
        };

        this.tasks.set(taskId, nextTask);

        try {
            await this.saveTask(nextTask);
            await this.scheduleTask(taskId);
            return cloneValue(nextTask);
        } catch (error) {
            this.tasks.set(taskId, previousTask);
            await this.saveTask(previousTask);
            await this.scheduleTask(taskId);
            throw error;
        }
    }

    async removeTask(taskId: string): Promise<boolean> {
        if (!this.tasks.has(taskId)) {
            return false;
        }

        this.unscheduleTask(taskId);
        this.tasks.delete(taskId);
        this.runningTasks.delete(taskId);
        this.scheduleVersions.delete(taskId);
        await this.deleteTask(taskId);
        return true;
    }

    async scheduleTask(taskId: string): Promise<void> {
        const task = this.tasks.get(taskId);
        if (!task) {
            return;
        }

        const version = this.bumpScheduleVersion(taskId);
        this.clearTaskResources(taskId);

        if (!task.enabled) {
            task.nextRunAt = null;
            task.updatedAt = Date.now();
            await this.saveTask(task);
            return;
        }

        await this.scheduleTaskWithVersion(task, version);
    }

    unscheduleTask(taskId: string): void {
        this.bumpScheduleVersion(taskId);
        this.clearTaskResources(taskId);

        const task = this.tasks.get(taskId);
        if (!task) {
            return;
        }

        task.nextRunAt = null;
        task.updatedAt = Date.now();
        void this.saveTask(task);
    }

    calculateNextRun(trigger: ScheduleTrigger, from: Date = new Date()): number | null {
        switch (trigger.type) {
            case 'interval': {
                if (!Number.isFinite(trigger.milliseconds) || trigger.milliseconds <= 0) {
                    throw new Error('Interval trigger milliseconds must be greater than 0');
                }

                return from.getTime() + trigger.milliseconds;
            }
            case 'once': {
                if (!Number.isFinite(trigger.timestamp)) {
                    throw new Error('Once trigger timestamp must be a valid number');
                }

                return trigger.timestamp;
            }
            case 'cron': {
                const cron = new Cron(trigger.expression, { paused: true });
                const nextRun = cron.nextRun(from);
                return nextRun?.getTime() ?? null;
            }
            case 'event': {
                return null;
            }
            default: {
                return null;
            }
        }
    }

    async executeTask(taskId: string, expectedScheduleVersion?: number): Promise<void> {
        const task = this.tasks.get(taskId);
        if (!task || !task.enabled) {
            return;
        }

        if (
            expectedScheduleVersion !== undefined &&
            !this.isCurrentScheduleVersion(taskId, expectedScheduleVersion)
        ) {
            return;
        }

        if (this.runningTasks.has(taskId)) {
            console.warn(`[TaskScheduler] Task ${taskId} is already running, skipping overlap`);
            return;
        }

        this.runningTasks.add(taskId);

        const startedAt = Date.now();
        task.lastRunAt = startedAt;
        task.updatedAt = startedAt;
        await this.saveTask(task);

        try {
            const startedTask = await sessionTaskCenter.startBackgroundTask({
                prompt: task.prompt,
                modelId: task.modelId,
                providerId: task.providerId,
            });
            await startedTask.completion;
        } catch (error) {
            console.error(`[TaskScheduler] Failed to execute task ${taskId}:`, error);
        } finally {
            this.runningTasks.delete(taskId);
        }

        const latestTask = this.tasks.get(taskId);
        if (!latestTask) {
            return;
        }

        if (
            expectedScheduleVersion !== undefined &&
            !this.isCurrentScheduleVersion(taskId, expectedScheduleVersion)
        ) {
            return;
        }

        if (latestTask.trigger.type === 'once') {
            latestTask.enabled = false;
            latestTask.nextRunAt = null;
            this.clearTaskResources(taskId);
        }

        latestTask.updatedAt = Date.now();
        await this.saveTask(latestTask);
    }

    private async scheduleTaskWithVersion(task: ScheduledTask, version: number): Promise<void> {
        switch (task.trigger.type) {
            case 'interval': {
                const nextRunAt = this.calculateNextRun(task.trigger);
                task.nextRunAt = nextRunAt;
                task.updatedAt = Date.now();
                await this.saveTask(task);

                const intervalHandle = setInterval(() => {
                    if (!this.isCurrentScheduleVersion(task.id, version)) {
                        return;
                    }

                    const currentTask = this.tasks.get(task.id);
                    if (
                        !currentTask ||
                        !currentTask.enabled ||
                        currentTask.trigger.type !== 'interval'
                    ) {
                        return;
                    }

                    currentTask.nextRunAt = Date.now() + currentTask.trigger.milliseconds;
                    currentTask.updatedAt = Date.now();
                    void this.saveTask(currentTask);
                    void this.executeTask(task.id, version);
                }, task.trigger.milliseconds);

                this.timers.set(task.id, {
                    kind: 'interval',
                    handle: intervalHandle,
                });
                return;
            }
            case 'once': {
                const nextRunAt = this.calculateNextRun(task.trigger);
                task.nextRunAt = nextRunAt;
                task.updatedAt = Date.now();
                await this.saveTask(task);

                const delay = Math.max((nextRunAt ?? Date.now()) - Date.now(), 0);
                const timeoutHandle = setTimeout(async () => {
                    if (!this.isCurrentScheduleVersion(task.id, version)) {
                        return;
                    }

                    await this.executeTask(task.id, version);
                }, delay);

                this.timers.set(task.id, {
                    kind: 'timeout',
                    handle: timeoutHandle,
                });
                return;
            }
            case 'cron': {
                await this.armCronTimeout(task.id, version);
                return;
            }
            case 'event': {
                task.nextRunAt = null;
                task.updatedAt = Date.now();
                await this.saveTask(task);

                const cleanup = await eventTriggerRegistry.setupEventTrigger(task.trigger, () => {
                    if (!this.isCurrentScheduleVersion(task.id, version)) {
                        return;
                    }

                    void this.executeTask(task.id, version);
                });

                if (!this.isCurrentScheduleVersion(task.id, version)) {
                    cleanup();
                    return;
                }

                this.eventCleanups.set(task.id, cleanup);
                return;
            }
            default: {
                return;
            }
        }
    }

    private async armCronTimeout(taskId: string, version: number): Promise<void> {
        const task = this.tasks.get(taskId);
        if (!task || !task.enabled || task.trigger.type !== 'cron') {
            return;
        }

        const nextRunAt = this.calculateNextRun(task.trigger);
        task.nextRunAt = nextRunAt;
        task.updatedAt = Date.now();
        await this.saveTask(task);

        if (nextRunAt === null) {
            return;
        }

        const delay = Math.max(nextRunAt - Date.now(), 0);
        const timeoutHandle = setTimeout(async () => {
            if (!this.isCurrentScheduleVersion(taskId, version)) {
                return;
            }

            const currentTask = this.tasks.get(taskId);
            if (!currentTask || !currentTask.enabled || currentTask.trigger.type !== 'cron') {
                return;
            }

            await this.armCronTimeout(taskId, version);
            await this.executeTask(taskId, version);
        }, delay);

        this.timers.set(taskId, {
            kind: 'timeout',
            handle: timeoutHandle,
        });
    }

    private clearTaskResources(taskId: string): void {
        const timer = this.timers.get(taskId);
        if (timer) {
            if (timer.kind === 'interval') {
                clearInterval(timer.handle);
            } else {
                clearTimeout(timer.handle);
            }
            this.timers.delete(taskId);
        }

        const cleanup = this.eventCleanups.get(taskId);
        if (cleanup) {
            cleanup();
            this.eventCleanups.delete(taskId);
        }
    }

    private bumpScheduleVersion(taskId: string): number {
        const nextVersion = (this.scheduleVersions.get(taskId) ?? 0) + 1;
        this.scheduleVersions.set(taskId, nextVersion);
        return nextVersion;
    }

    private isCurrentScheduleVersion(taskId: string, version: number): boolean {
        return this.scheduleVersions.get(taskId) === version;
    }

    private async saveTask(task: ScheduledTask): Promise<void> {
        // Part 2: 持久化到数据库。
        void task;
    }

    private async deleteTask(taskId: string): Promise<void> {
        // Part 2: 从数据库删除。
        void taskId;
    }
}

export const taskScheduler = new TaskScheduler();
