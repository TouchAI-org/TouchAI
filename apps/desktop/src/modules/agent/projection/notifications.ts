// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * 任务快照通知合并器。
 *
 * 流式期间快照变化非常频繁，逐个推送会重复克隆快照。这里把同一 tick 内的
 * 流式通知合并成一次推送；审批、终态、错误等关键路径不经过这里，直接立即推送。
 *
 * 调度使用定时器而不是微任务，便于在任务释放 / dispose 时显式清掉，避免悬挂。
 */

export class NotificationCoalescer {
    private readonly scheduled = new Set<string>();
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(
        private readonly onFlush: (taskId: string) => void,
        private readonly delayMs = 0
    ) {}

    /** 合并推送：同一 task 在一个 tick 内只会 flush 一次。 */
    schedule(taskId: string): void {
        this.scheduled.add(taskId);
        if (this.timer !== null) {
            return;
        }
        this.timer = setTimeout(() => {
            this.timer = null;
            this.flushAll();
        }, this.delayMs);
    }

    /** 立即推送某个 task，并取消它已排队的合并推送。 */
    flushNow(taskId: string): void {
        this.scheduled.delete(taskId);
        this.onFlush(taskId);
    }

    /** 取消某个 task 已排队的合并推送（任务释放时调用）。 */
    cancel(taskId: string): void {
        this.scheduled.delete(taskId);
    }

    /** 清掉定时器与全部待推送项。 */
    dispose(): void {
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.scheduled.clear();
    }

    private flushAll(): void {
        const taskIds = Array.from(this.scheduled);
        this.scheduled.clear();
        for (const taskId of taskIds) {
            this.onFlush(taskId);
        }
    }
}
