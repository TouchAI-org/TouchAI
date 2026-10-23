// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { AiStreamChunk } from '@services/AgentService/contracts/protocol';
import {
    AppEvent,
    eventService,
    type SessionTaskUsageProgressEvent,
    type UsageThroughputSample,
} from '@services/EventService';

/** Minimum gap between pushes; denser only burns UI and IPC time. */
const EMIT_INTERVAL_MS = 200;

/** Rolling sample cap, matching the live curve's x-axis capacity. */
const MAX_SAMPLES = 60;

/**
 * Speed uses a recent window; otherwise early samples are dragged down by TTFT
 * and later ones flattened by the whole history.
 */
const SPEED_WINDOW_MS = 5000;

/**
 * Estimate tokens from a character mix.
 *
 * Same coefficients as `utils/promptBreakdown`, but that helper rescans the
 * whole text and re-running it per streamed chunk is O(n^2). Accumulating two
 * character counts incrementally keeps this O(1).
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
    /** Null when the model has no pricing; cost is then hidden. */
    estimatedInputCostPerMillion?: number | null;
    estimatedOutputCostPerMillion?: number | null;
}

/**
 * Converts streamed chunks into live usage and throttles the pushes.
 *
 * Providers report true token counts only when a call ends, so tokens and cost
 * during streaming are estimated from the characters received. No fake
 * precision is applied: the finish path pushes the measured values once with
 * `estimated` set to false so the UI can tell the two apart.
 */
export class LiveUsageTracker {
    private readonly startedAt = Date.now();
    private readonly samples: UsageThroughputSample[] = [];
    /**
     * Snapshots of the real cumulative counter.
     *
     * Deriving tokens from "previous speed x interval" accumulates error on
     * every push and drifts badly over a long conversation. Recording the
     * counter itself makes each delta exact.
     */
    private readonly tokenMarks: Array<{ atMs: number; tokens: number }> = [];

    private cjkChars = 0;
    private otherChars = 0;
    private firstContentAtMs: number | null = null;
    private lastEmitAtMs = 0;
    /** The first chunk pushes immediately, otherwise the panel lights up late. */
    private hasEmitted = false;
    private finished = false;
    /** Heartbeat so the rate decays during tool calls, when no chunk arrives. */
    private heartbeat: ReturnType<typeof setInterval> | null = null;

    constructor(private readonly options: LiveUsageTrackerOptions) {}

    /**
     * Start the heartbeat.
     *
     * The curve cannot update only on chunks: tool calls and first-token waits
     * produce none, so the plot would stay flat until the tool returns and then
     * jump. Recomputing the sliding window on a timer lets the rate fall to 0
     * while idle and rise again when output resumes.
     */
    start(): void {
        if (this.heartbeat || this.finished) return;
        this.heartbeat = setInterval(() => {
            if (this.finished) return;
            this.pushSample(Date.now() - this.startedAt);
            void eventService.emit(AppEvent.SESSION_TASK_USAGE_PROGRESS, this.snapshot());
        }, EMIT_INTERVAL_MS);
    }

    private stopHeartbeat(): void {
        if (!this.heartbeat) return;
        clearInterval(this.heartbeat);
        this.heartbeat = null;
    }

    /** Estimated output tokens. */
    private get estimatedTokens(): number {
        return Math.round(
            this.cjkChars * CJK_TOKENS_PER_CHAR + this.otherChars * OTHER_TOKENS_PER_CHAR
        );
    }

    /**
     * Current speed.
     *
     * Uses new tokens inside the window divided by the window length, not the
     * total divided by total time: the latter permanently averages first-token
     * latency and tool pauses into the number.
     *
     * Returns 0 when the window holds no new tokens instead of holding the
     * previous value. A tool call really produces nothing, and the curve should
     * sink to the baseline; holding the value makes that stretch look frozen
     * until the tool returns and it jumps.
     */
    private currentSpeed(nowMs: number): number | null {
        /*
         * Return 0 rather than null before any output exists.
         *
         * Null makes the heartbeat skip the push, so first-token waits and
         * early tool calls show no data at all and look stalled. Zero is the
         * honest value: nothing has been produced yet.
         */
        if (this.firstContentAtMs === null) {
            return 0;
        }

        // Last counter snapshot at or before the window start is the baseline.
        const cutoff = nowMs - SPEED_WINDOW_MS;
        let baseline: { atMs: number; tokens: number } | null = null;
        for (const mark of this.tokenMarks) {
            if (mark.atMs > cutoff) break;
            baseline = mark;
        }
        if (!baseline) {
            baseline = this.tokenMarks[0] ?? null;
        }
        if (!baseline) {
            return null;
        }

        const windowSeconds = (nowMs - baseline.atMs) / 1000;
        if (windowSeconds <= 0) {
            return null;
        }

        const deltaTokens = this.estimatedTokens - baseline.tokens;
        // A negative delta should not happen; 0 means the window produced nothing.
        return Math.max(0, deltaTokens) / windowSeconds;
    }

    /** Record the counter, keeping only twice the window so the array stays bounded. */
    private markTokens(nowMs: number): void {
        this.tokenMarks.push({ atMs: nowMs, tokens: this.estimatedTokens });
        const cutoff = nowMs - SPEED_WINDOW_MS * 2;
        while (this.tokenMarks.length > 2 && this.tokenMarks[0]!.atMs < cutoff) {
            this.tokenMarks.shift();
        }
    }

    /**
     * Called once per chunk; accumulates character counts instead of rescanning.
     *
     * The consumer samples the aggregate speed on a fixed tick, so this only
     * pushes the current instantaneous value rather than keeping a per-task
     * sample series that the UI would have to align.
     */
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

        // Reasoning counts toward throughput: the user perceives thinking as motion.
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
        if (added) {
            this.markTokens(nowMs);
        }
        if (this.hasEmitted && nowMs - this.lastEmitAtMs < EMIT_INTERVAL_MS) {
            return;
        }

        this.hasEmitted = true;
        this.pushSample(nowMs);
        void eventService.emit(AppEvent.SESSION_TASK_USAGE_PROGRESS, this.snapshot());
    }

    /**
     * Close the turn with measured values.
     *
     * Tokens become the provider's real count. Cost stays an estimate because
     * it is only finalised when the turn is persisted against current pricing;
     * passing null keeps the last streamed estimate instead of blanking the
     * field.
     */
    finish(actual: { outputTokens: number; costMicros: number | null }): void {
        if (this.finished) {
            return;
        }

        this.finished = true;
        this.stopHeartbeat();
        const snapshot = this.snapshot();
        void eventService.emit(AppEvent.SESSION_TASK_USAGE_PROGRESS, {
            ...snapshot,
            outputTokens: actual.outputTokens,
            estimatedCostMicros: actual.costMicros ?? snapshot.estimatedCostMicros,
            streaming: false,
        });
    }

    /**
     * Stop pushing without rewriting the numbers.
     *
     * A failure or cancellation yields no measured usage from the provider, so
     * keeping the estimate is more honest than reporting zero.
     */
    stop(): void {
        if (this.finished) {
            return;
        }

        this.finished = true;
        this.stopHeartbeat();
        void eventService.emit(AppEvent.SESSION_TASK_USAGE_PROGRESS, {
            ...this.snapshot(),
            streaming: false,
        });
    }

    private pushSample(nowMs: number): void {
        const speed = this.currentSpeed(nowMs);
        if (speed === null || !Number.isFinite(speed)) {
            // The window has zero length on the first chunk; do not invent a sample.
            this.lastEmitAtMs = nowMs;
            return;
        }

        this.lastEmitAtMs = nowMs;
        // Record the cumulative count too: the consumer splices the live tail
        // onto the history curve with it.
        this.samples.push({
            atMs: nowMs,
            tokensPerSecond: speed,
            totalTokens: this.estimatedTokens,
        });
        if (this.samples.length > MAX_SAMPLES) {
            this.samples.shift();
        }
    }

    private snapshot(): SessionTaskUsageProgressEvent {
        const outputTokens = this.estimatedTokens;

        return {
            taskId: this.options.taskId,
            sessionId: this.options.sessionId,
            modelName: this.options.modelName,
            outputTokens,
            tokensPerSecond: this.samples[this.samples.length - 1]?.tokensPerSecond ?? null,
            elapsedMs: Date.now() - this.startedAt,
            ttftMs: this.firstContentAtMs,
            estimatedCostMicros: this.estimateCost(outputTokens),
            // The caller flips this to false when closing out.
            streaming: !this.finished,
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
