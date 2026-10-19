// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { AiStreamChunk } from '@services/AgentService/contracts/protocol';
import {
    AppEvent,
    eventService,
    type SessionTaskUsageProgressEvent,
    type UsageThroughputSample,
} from '@services/EventService';

/** 两次推送之间的最短间隔；太密会让 UI 与 IPC 白跑 */
const EMIT_INTERVAL_MS = 300;

/** 滚动采样上限，与实时曲线的横轴容量一致 */
const MAX_SAMPLES = 60;

/** 速度按「最近一段时间」算，否则初期会被 TTFT 拖低、后期被历史摊平 */
const SPEED_WINDOW_MS = 5000;

/**
 * CJK 字符占比估算 token。
 *
 * 与 `utils/promptBreakdown` 同一套系数，但那里按整段文本重算，
 * 流式场景每来一个片段就重算整段是 O(n²)。这里按增量累计两种字符数，
 * 复杂度是 O(1)。
 */
const CJK_TOKENS_PER_CHAR = 1 / 1.5;
const OTHER_TOKENS_PER_CHAR = 1 / 4;

function isCjk(codePoint: number): boolean {
    return (
        (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
        (codePoint >= 0x3040 && codePoint <= 0x30ff) ||
        (codePoint >= 0xac00 && codePoint <= 0xd7af)
    );
}

export interface LiveUsageTrackerOptions {
    taskId: string;
    sessionId: number | null;
    modelName: string;
    /** 无定价时为 null，此时不展示成本 */
    estimatedInputCostPerMillion?: number | null;
    estimatedOutputCostPerMillion?: number | null;
}

/**
 * 把流式片段折算成实时用量并节流推送。
 *
 * 供应商只在调用结束时返回真实 token 数，所以流式期间的 token 与成本
 * 都是按已流入字符估算的。这里不做假精度处理：结束时会用实测值再推一次，
 * 并把 `estimated` 置为 false，让 UI 能区分两段语义。
 */
export class LiveUsageTracker {
    private readonly startedAt = Date.now();
    private readonly samples: UsageThroughputSample[] = [];

    private cjkChars = 0;
    private otherChars = 0;
    private firstContentAtMs: number | null = null;
    private lastEmitAtMs = 0;
    /** 首个片段立即推送，否则面板会晚一拍才点亮 */
    private hasEmitted = false;
    private finished = false;

    constructor(private readonly options: LiveUsageTrackerOptions) {}

    /** 输出 token 估算值 */
    private get estimatedTokens(): number {
        return Math.round(
            this.cjkChars * CJK_TOKENS_PER_CHAR + this.otherChars * OTHER_TOKENS_PER_CHAR
        );
    }

    /**
     * 当前速度。
     *
     * 用「窗口内新增 token / 窗口时长」而不是「总量 / 总时长」：
     * 前者反映此刻的吞吐，后者会把首字延迟与工具停顿永久摊进平均值。
     */
    private currentSpeed(nowMs: number): number | null {
        if (this.firstContentAtMs === null) {
            return null;
        }

        const windowStart = Math.max(this.firstContentAtMs, nowMs - SPEED_WINDOW_MS);
        const windowSeconds = (nowMs - windowStart) / 1000;
        if (windowSeconds <= 0) {
            return null;
        }

        const previous = this.samples[this.samples.length - 1];
        const previousTokens = previous ? this.tokensAt(previous.atMs) : 0;
        const deltaTokens = this.estimatedTokens - previousTokens;
        if (deltaTokens <= 0) {
            return previous?.tokensPerSecond ?? null;
        }

        return deltaTokens / windowSeconds;
    }

    /**
     * 某时刻的 token 数。
     *
     * 采样里只存了速度，没有存绝对量，这里按采样时刻反推一个保守值：
     * 仅用于计算两次推送之间的增量，误差不会累积到最终数字。
     */
    private tokensAt(atMs: number): number {
        let sum = 0;
        for (let index = 0; index < this.samples.length; index += 1) {
            const current = this.samples[index]!;
            const next = this.samples[index + 1];
            const spanEnd = next ? next.atMs : atMs;
            sum += (current.tokensPerSecond * (spanEnd - current.atMs)) / 1000;
        }
        return sum;
    }

    /** 每个片段调用一次；内部按字符增量累计，不做整段重算 */
    consume(chunk: AiStreamChunk): void {
        if (this.finished) {
            return;
        }

        let added = false;
        if (chunk.content) {
            for (const char of chunk.content) {
                if (isCjk(char.codePointAt(0) ?? 0)) {
                    this.cjkChars += 1;
                } else {
                    this.otherChars += 1;
                }
            }
            added = true;
        }

        // 推理内容同样计入吞吐：用户感知的「在动」包含思考阶段
        if (chunk.reasoning) {
            for (const char of chunk.reasoning) {
                if (isCjk(char.codePointAt(0) ?? 0)) {
                    this.cjkChars += 1;
                } else {
                    this.otherChars += 1;
                }
            }
            added = true;
        }

        if (added && this.firstContentAtMs === null) {
            this.firstContentAtMs = Date.now() - this.startedAt;
        }

        const nowMs = Date.now() - this.startedAt;
        if (this.hasEmitted && nowMs - this.lastEmitAtMs < EMIT_INTERVAL_MS) {
            return;
        }

        this.hasEmitted = true;
        this.pushSample(nowMs);
        void eventService.emit(AppEvent.SESSION_TASK_USAGE_PROGRESS, this.snapshot(false));
    }

    /**
     * 本轮结束时用实测值收尾。
     *
     * token 换成供应商返回的真实数字；成本仍为估算（它要等落库按当下定价算完），
     * `costMicros` 传 null 表示沿用流式期间最后算出的估算值，
     * 而不是把这一格清空。
     */
    finish(actual: { outputTokens: number; costMicros: number | null }): void {
        this.finished = true;
        const snapshot = this.snapshot(true);
        void eventService.emit(AppEvent.SESSION_TASK_USAGE_PROGRESS, {
            ...snapshot,
            outputTokens: actual.outputTokens,
            estimatedCostMicros: actual.costMicros ?? snapshot.estimatedCostMicros,
        });
    }

    /**
     * 停止推送但不改写数字。
     *
     * 失败或取消时拿不到供应商的实测用量，保留估算值比报 0 诚实。
     */
    stop(): void {
        if (this.finished) {
            return;
        }

        this.finished = true;
        void eventService.emit(AppEvent.SESSION_TASK_USAGE_PROGRESS, this.snapshot(true));
    }

    private pushSample(nowMs: number): void {
        const speed = this.currentSpeed(nowMs);
        if (speed === null || !Number.isFinite(speed) || speed <= 0) {
            // 首个片段时窗口长度为零，算不出速度；此时不造假样本
            this.lastEmitAtMs = nowMs;
            return;
        }

        this.lastEmitAtMs = nowMs;
        this.samples.push({ atMs: nowMs, tokensPerSecond: speed });
        if (this.samples.length > MAX_SAMPLES) {
            this.samples.shift();
        }
    }

    private snapshot(finished: boolean): SessionTaskUsageProgressEvent {
        const outputTokens = this.estimatedTokens;

        return {
            taskId: this.options.taskId,
            sessionId: this.options.sessionId,
            modelName: this.options.modelName,
            outputTokens,
            tokensPerSecond: this.samples[this.samples.length - 1]?.tokensPerSecond ?? null,
            elapsedMs: Date.now() - this.startedAt,
            ttftMs: this.firstContentAtMs,
            activeStreams: finished ? 0 : 1,
            estimatedCostMicros: this.estimateCost(outputTokens),
            samples: [...this.samples],
            finished,
        };
    }

    private estimateCost(outputTokens: number): number | null {
        const outputPrice = this.options.estimatedOutputCostPerMillion;
        if (outputPrice === null || outputPrice === undefined) {
            return null;
        }

        return Math.round(outputTokens * outputPrice);
    }
}
