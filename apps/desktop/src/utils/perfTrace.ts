// Copyright (c) 2026. 千诚. Licensed under GPL v3

/**
 * 轻量性能埋点。
 *
 * 目的：为"用户能感受到的动作"提供统一的分段耗时数据（hotkey→可见、
 * chunk→paint、history→首屏等），同时保持近乎零开销：
 * - 默认只保留最近 200 条样本，避免无限增长；
 * - 关闭时不做任何测量或分配；
 * - 通过 `window.__TOUCHAI_PERF__` 可在 devtools/自动化中直接读取。
 */
export interface PerfSample {
    label: string;
    durationMs: number;
    at: number;
    details?: Record<string, unknown>;
}

const MAX_SAMPLES = 200;
const samples: PerfSample[] = [];

function now(): number {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();
}

function globalEnabled(): boolean {
    if (typeof window === 'undefined') {
        return true;
    }

    const globalWithFlag = window as Window & { __TOUCHAI_PERF_ENABLED__?: boolean };
    return globalWithFlag.__TOUCHAI_PERF_ENABLED__ !== false;
}

export interface PerfTraceHandle {
    end(details?: Record<string, unknown>): number;
}

export function createPerfTrace(
    label: string,
    options: { enabled?: boolean } = {}
): PerfTraceHandle {
    const enabled = options.enabled ?? globalEnabled();
    const startedAt = enabled ? now() : 0;
    let finished = false;

    return {
        end(details) {
            if (!enabled || finished) {
                return 0;
            }
            finished = true;

            const durationMs = now() - startedAt;
            samples.push({ label, durationMs, at: Date.now(), details });
            if (samples.length > MAX_SAMPLES) {
                samples.splice(0, samples.length - MAX_SAMPLES);
            }

            return durationMs;
        },
    };
}

export function getPerfSamples(): readonly PerfSample[] {
    return samples;
}

export function resetPerfSamples(): void {
    samples.length = 0;
}

if (typeof window !== 'undefined') {
    (window as Window & { __TOUCHAI_PERF__?: unknown }).__TOUCHAI_PERF__ = {
        getSamples: getPerfSamples,
        reset: resetPerfSamples,
        mark: (label: string) => {
            const trace = createPerfTrace(label);
            return () => trace.end();
        },
    };
}
