// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { normalizeOutputParts, type PersistedOutputPart } from '../contracts/protocol';

/**
 * 进度快照的有界写入器。
 *
 * 流式进度是「可替换快照」：只有最新一份有意义，中间态可以被覆盖。
 * 因此写入保持 **1 in-flight + 1 latest pending** 的背压：
 * - 同时最多一个写入在飞；
 * - 在飞期间到达的新快照只保留最新一份，旧的 pending 被覆盖；
 * - 语义写入（工具调用 / 工具结果 / checkpoint）不经过这里，绝不会被丢弃。
 *
 * 每个写入都固定它所属的 attempt 身份（taskId + attemptToken）与 revision，
 * 便于断言旧 attempt 的 pending 不会写进新 attempt。
 */

export interface ProgressWriteTarget {
    taskId: string;
    attemptToken: string;
    /** 创建写入器时所属的 attempt 代次；落库前由 owner 校验。 */
    attemptGeneration: number;
    /** attempt 内的模型 step 序号（等价于 iteration）；用于拒绝旧 step 的迟到写入。 */
    step: number;
}

export interface ProgressWrite {
    taskId: string;
    attemptToken: string;
    attemptGeneration: number;
    step: number;
    revision: number;
    parts: PersistedOutputPart[];
}

type PersistProgress = (write: ProgressWrite) => Promise<void>;
type OnError = (error: unknown, write: ProgressWrite) => void;

export class LatestProgressWriter {
    private inFlight: Promise<void> | null = null;
    private pending: ProgressWrite | null = null;
    private closed = false;
    private revision = 0;

    constructor(
        private readonly target: ProgressWriteTarget,
        private readonly persist: PersistProgress,
        private readonly onError: OnError = () => {}
    ) {}

    get attemptToken(): string {
        return this.target.attemptToken;
    }

    /** 最近一次被接受（在飞或排队）的快照签名，用于去重。 */
    private lastAcceptedSignature: string | null = null;

    /**
     * 接受一份新的进度快照。
     *
     * - 已关闭或空快照忽略；
     * - 与最近接受过的快照相同则忽略；
     * - 否则覆盖 pending（旧 pending 被 supersede，不再写入）。
     */
    enqueue(parts: PersistedOutputPart[]): void {
        if (this.closed) {
            return;
        }
        const normalized = normalizeOutputParts(parts);
        if (normalized.length === 0) {
            return;
        }

        const signature = JSON.stringify(normalized);
        if (signature === this.lastAcceptedSignature) {
            return;
        }
        this.lastAcceptedSignature = signature;

        this.revision += 1;
        this.pending = {
            taskId: this.target.taskId,
            attemptToken: this.target.attemptToken,
            attemptGeneration: this.target.attemptGeneration,
            step: this.target.step,
            revision: this.revision,
            parts: normalized,
        };
        this.pump();
    }

    /** 关闭写入器：停止接受新快照并丢弃尚未开始的 pending。 */
    close(): void {
        this.closed = true;
        this.pending = null;
    }

    /** 等待当前在飞写入与它吸收的 pending 全部落盘。 */
    async drain(): Promise<void> {
        while (this.inFlight) {
            await this.inFlight;
        }
    }

    private pump(): void {
        if (this.closed || this.inFlight || !this.pending) {
            return;
        }

        const write = this.pending;
        this.pending = null;
        this.inFlight = this.invoke(write).finally(() => {
            this.inFlight = null;
            if (!this.closed) {
                this.pump();
            }
        });
    }

    private invoke(write: ProgressWrite): Promise<void> {
        let result: Promise<void>;
        try {
            result = this.persist(write);
        } catch (error) {
            this.onError(error, write);
            return Promise.resolve();
        }

        return result.then(undefined, (error) => {
            this.onError(error, write);
        });
    }
}
