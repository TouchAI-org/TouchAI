// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { useStateMachine } from 'reka-ui';

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
    const lifecycle = useStateMachine('idle', {
        idle: { schedule: 'scheduled', dispose: 'disposed' },
        scheduled: { start: 'loading', dispose: 'disposed' },
        loading: { complete: 'idle', dispose: 'disposed' },
        disposed: {},
    });
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
        if (lifecycle.state.value !== 'idle' || queue.length === 0) return;
        lifecycle.dispatch('schedule');
        const cancel = schedule(drainQueue);
        if (typeof cancel !== 'function') return;
        if (isScheduled()) {
            cancelScheduled = cancel;
        } else if (isDisposed()) {
            cancel();
        }
    }

    function drainQueue(): void {
        if (lifecycle.state.value !== 'scheduled') return;
        cancelScheduled = undefined;
        lifecycle.dispatch('start');
        const nextSection = queue.shift();
        if (nextSection === undefined) {
            lifecycle.dispatch('complete');
            return;
        }

        inFlightSections.add(nextSection);
        void loadSection(nextSection);
    }

    async function loadSection(section: string): Promise<void> {
        try {
            await options.load(section);
            loadedSections.add(section);
        } catch (error) {
            options.onError?.(section, error);
        } finally {
            inFlightSections.delete(section);
            lifecycle.dispatch('complete');
            scheduleDrain();
        }
    }

    function isDisposed(): boolean {
        return lifecycle.state.value === 'disposed';
    }

    function isScheduled(): boolean {
        return lifecycle.state.value === 'scheduled';
    }

    function prefetch(section: string, prefetchOptions: { priority?: boolean } = {}): void {
        if (isDisposed() || loadedSections.has(section) || inFlightSections.has(section)) {
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

        scheduleDrain();
    }

    return {
        prefetch,
        dispose() {
            lifecycle.dispatch('dispose');
            const cancel = cancelScheduled;
            cancelScheduled = undefined;
            queue.length = 0;
            cancel?.();
        },
        isLoaded: (section: string) => loadedSections.has(section),
        pendingCount: () => queue.length + inFlightSections.size,
    };
}
