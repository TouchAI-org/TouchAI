// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * 开发期主线程长任务观测。
 *
 * 「卡几秒」这类问题必须先知道是谁在主线程上跑了多久：这里把超过阈值的长任务
 * 打到控制台（dev 下会被转发到 Rust 日志），同时给出发生时刻。
 * 生产构建不注册任何 observer。
 */
const LONG_TASK_THRESHOLD_MS = 120;
const MAX_ENTRIES = 40;

export function installLongTaskProbe(): void {
    if (!import.meta.env.DEV || typeof PerformanceObserver === 'undefined') {
        return;
    }

    const startedAt = performance.now();
    let reported = 0;

    try {
        const observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
                if (reported >= MAX_ENTRIES || entry.duration < LONG_TASK_THRESHOLD_MS) {
                    continue;
                }

                reported += 1;
                console.warn('[longtask]', {
                    ms: Math.round(entry.duration),
                    at: Math.round(entry.startTime - startedAt),
                    name: entry.name,
                });
            }
        });

        observer.observe({ entryTypes: ['longtask'] });
    } catch {
        // 某些 WebView 不支持 longtask；静默跳过，不影响功能。
    }
}
