import type { LogEnvelope, LogLevelName } from './types';

export const DEFAULT_QUEUE_CAPACITY = 1000;
export const DEFAULT_BATCH_SIZE = 50;
export const DEFAULT_FLUSH_INTERVAL_MS = 250;

type DropCounts = Record<LogLevelName, number>;

const LEVEL_ORDER: LogLevelName[] = ['trace', 'debug', 'info', 'warn', 'error'];

const LEVEL_NAMES: Record<LogEnvelope['level'], LogLevelName> = {
    1: 'trace',
    2: 'debug',
    3: 'info',
    4: 'warn',
    5: 'error',
};

export interface LogQueueOptions {
    send: (batch: LogEnvelope[]) => Promise<void>;
    capacity?: number;
    batchSize?: number;
    flushIntervalMs?: number;
    onError?: (error: unknown) => void;
}

/**
 * 有界队列：满了先丢 trace/debug，再丢 info，warn/error 最后丢。
 * 丢弃数量在下一批开头以 `obs.dropped` 上报。
 */
export class LogQueue {
    private readonly items: LogEnvelope[] = [];
    private readonly send: LogQueueOptions['send'];
    private readonly capacity: number;
    private readonly batchSize: number;
    private readonly flushIntervalMs: number;
    private readonly onError: (error: unknown) => void;
    private readonly dropped: DropCounts = {
        trace: 0,
        debug: 0,
        info: 0,
        warn: 0,
        error: 0,
    };
    private timer: ReturnType<typeof setInterval> | null = null;
    private flushing: Promise<void> | null = null;

    constructor(options: LogQueueOptions) {
        this.send = options.send;
        this.capacity = options.capacity ?? DEFAULT_QUEUE_CAPACITY;
        this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
        this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
        this.onError = options.onError ?? (() => {});
    }

    push(envelope: LogEnvelope): void {
        if (this.items.length >= this.capacity) {
            this.makeRoomFor(envelope);
        }
        if (this.items.length < this.capacity) {
            this.items.push(envelope);
        }

        if (this.items.length >= this.batchSize) {
            void this.flush();
        }
    }

    start(): void {
        if (this.timer) return;
        this.timer = setInterval(() => {
            void this.flush();
        }, this.flushIntervalMs);
    }

    stop(): void {
        if (!this.timer) return;
        clearInterval(this.timer);
        this.timer = null;
    }

    size(): number {
        return this.items.length;
    }

    droppedCounts(): DropCounts {
        return { ...this.dropped };
    }

    async flush(): Promise<void> {
        if (this.flushing) {
            await this.flushing;
            return;
        }
        if (this.items.length === 0 && this.droppedTotal() === 0) return;

        this.flushing = this.sendBatch().finally(() => {
            this.flushing = null;
        });
        await this.flushing;
    }

    /**
     * 退出前刷盘：发送失败时再试一次。
     *
     * 常规 flush 失败后把批次放回队列等下一次定时刷写，但进程退出后不会再有
     * 下一次，所以这里给最后一批多一次机会。
     */
    async flushWithRetry(attempts = 2): Promise<void> {
        for (let attempt = 0; attempt < attempts; attempt += 1) {
            await this.flush();
            if (this.items.length === 0 && this.droppedTotal() === 0) return;
        }
    }

    private async sendBatch(): Promise<void> {
        while (this.items.length > 0 || this.droppedTotal() > 0) {
            const batch: LogEnvelope[] = [];

            const droppedEvent = this.takeDroppedEvent();
            if (droppedEvent) {
                batch.push(droppedEvent);
            }
            batch.push(...this.items.splice(0, this.batchSize));

            try {
                await this.send(batch);
            } catch (error) {
                // 发送失败时把这一批放回队首，等下一次 flush 重试，避免整批日志丢失。
                this.requeue(batch);
                this.onError(error);
                return;
            }
        }
    }

    /** 放回队首并保持容量上限；溢出时优先丢弃低级别日志。 */
    private requeue(batch: LogEnvelope[]): void {
        this.items.unshift(...batch);
        while (this.items.length > this.capacity) {
            this.dropOne();
        }
    }

    private takeDroppedEvent(): LogEnvelope | null {
        const counts = this.dropped;
        if (this.droppedTotal() === 0) return null;

        const attrs: Record<string, number> = {};
        for (const level of Object.keys(counts) as LogLevelName[]) {
            if (counts[level] > 0) {
                attrs[`dropped.${level}`] = counts[level];
                counts[level] = 0;
            }
        }

        return {
            level: 4,
            event: 'obs.dropped',
            attrs,
        };
    }

    /** 满了以后比较严重程度：新事件更弱就丢它，否则挤掉队里最弱的一条。 */
    private makeRoomFor(incoming: LogEnvelope): void {
        const incomingLevel = LEVEL_NAMES[incoming.level];
        const weakest = LEVEL_ORDER.find((level) =>
            this.items.some((item) => LEVEL_NAMES[item.level] === level)
        );

        if (
            weakest === undefined ||
            LEVEL_ORDER.indexOf(incomingLevel) < LEVEL_ORDER.indexOf(weakest)
        ) {
            this.dropped[incomingLevel] += 1;
            return;
        }

        this.dropOne();
    }

    private dropOne(): void {
        for (const level of LEVEL_ORDER) {
            const index = this.items.findIndex((item) => LEVEL_NAMES[item.level] === level);
            if (index >= 0) {
                this.items.splice(index, 1);
                this.dropped[level] += 1;
                return;
            }
        }
    }

    private droppedTotal(): number {
        return Object.values(this.dropped).reduce((total, count) => total + count, 0);
    }
}
