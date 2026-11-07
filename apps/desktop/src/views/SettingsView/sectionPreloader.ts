// Copyright (c) 2026. 千诚. Licensed under GPL v3

export interface SectionPreloaderOptions {
    load: (section: string) => Promise<unknown>;
    /** 调度下一次加载；默认在空闲时执行，避免与首屏交互抢主线程。 */
    schedule?: (run: () => void) => void | (() => void);
    onError?: (section: string, error: unknown) => void;
}

/**
 * 串行区块预加载器。
 *
 * 设置页此前在首个 rAF 里并发加载全部区块；这里改为：
 * - 同一区块只加载一次；
 * - 同时只有一个加载在跑；
 * - hover/focus 触发的预取可以插队，优先响应用户下一步意图。
 */
export function createSectionPreloader(options: SectionPreloaderOptions) {
    const loadedSections = new Set<string>();
    const inFlightSections = new Set<string>();
    const queue: string[] = [];
    let draining = false;
    let disposed = false;
    let cancelScheduled: (() => void) | undefined;

    const schedule =
        options.schedule ??
        ((run: () => void) => {
            const requestIdle = (
                globalThis as {
                    requestIdleCallback?: (
                        callback: () => void,
                        options?: { timeout: number }
                    ) => number;
                }
            ).requestIdleCallback;

            if (typeof requestIdle === 'function') {
                const handle = requestIdle(() => run(), { timeout: 1200 });
                return () => globalThis.cancelIdleCallback(handle);
            }

            const handle = setTimeout(run, 200);
            return () => clearTimeout(handle);
        });

    function scheduleDrain(): void {
        const cancel = schedule(drainQueue);
        cancelScheduled = typeof cancel === 'function' ? cancel : undefined;
    }

    function drainQueue(): void {
        cancelScheduled = undefined;
        if (disposed) return;
        const nextSection = queue.shift();
        if (nextSection === undefined) {
            draining = false;
            return;
        }

        inFlightSections.add(nextSection);
        void options
            .load(nextSection)
            .then(() => {
                loadedSections.add(nextSection);
            })
            .catch((error: unknown) => {
                options.onError?.(nextSection, error);
            })
            .finally(() => {
                inFlightSections.delete(nextSection);
                if (!disposed && queue.length > 0) {
                    scheduleDrain();
                } else {
                    draining = false;
                }
            });
    }

    function prefetch(section: string, prefetchOptions: { priority?: boolean } = {}): void {
        if (disposed || loadedSections.has(section) || inFlightSections.has(section)) {
            return;
        }

        const queuedIndex = queue.indexOf(section);
        if (queuedIndex >= 0) {
            if (!prefetchOptions.priority) return;
            queue.splice(queuedIndex, 1);
        }

        if (prefetchOptions.priority) {
            queue.unshift(section);
        } else {
            queue.push(section);
        }

        if (draining) {
            return;
        }

        draining = true;
        scheduleDrain();
    }

    return {
        prefetch,
        dispose() {
            disposed = true;
            cancelScheduled?.();
            cancelScheduled = undefined;
            queue.length = 0;
        },
        isLoaded: (section: string) => loadedSections.has(section),
        pendingCount: () => queue.length + inFlightSections.size,
    };
}
