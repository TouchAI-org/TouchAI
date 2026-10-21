// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { onActivated, onBeforeUnmount, onMounted, type Ref, ref, watch } from 'vue';

/**
 * 自动量测区块高度，供骨架屏复用。
 *
 * 手写 `min-h-[415px]` 这类数字必然和真实内容漂移：改一行字号、加一个指标卡，
 * 数字就过时了，而没有人会记得同步骨架。这里改成量出来：
 * 真实内容渲染后用 ResizeObserver 记录每块高度，写进 localStorage；
 * 下次进页面时骨架直接套用这些实测值。
 *
 * 首次访问没有记录时回退到空数组，骨架用自身内容撑开——不会报错，只是不够准。
 * 记录带版本号：布局大改时改 `version`，旧数据自动作废。
 */
const STORAGE_PREFIX = 'touchai.usage.block-heights';

/** 布局稳定等待时长：低于这个时间量到的是中间态 */
const SETTLE_MS = 1200;

export function useMeasuredBlockHeights(
    containerRef: Ref<HTMLElement | null>,
    options: { key: string; version: number }
) {
    const storageKey = `${STORAGE_PREFIX}.${options.key}.v${options.version}`;
    const heights = ref<number[]>([]);

    function read(): number[] {
        try {
            const raw = window.localStorage.getItem(storageKey);
            if (!raw) return [];
            const parsed: unknown = JSON.parse(raw);
            if (!Array.isArray(parsed)) return [];
            return parsed.filter(
                (value): value is number => typeof value === 'number' && Number.isFinite(value)
            );
        } catch {
            // localStorage 不可用（隐私模式、配额满）时静默降级
            return [];
        }
    }

    function write(next: number[]): void {
        try {
            window.localStorage.setItem(storageKey, JSON.stringify(next));
        } catch {
            // 同上：量测失败不影响页面
        }
    }

    /** 读取容器直接子元素的高度（骨架与真实内容都是同样的子块顺序） */
    function measure(): number[] {
        const el = containerRef.value;
        if (!el) return [];
        return [...el.children].map((child) => Math.round(child.getBoundingClientRect().height));
    }

    let observer: ResizeObserver | null = null;
    let frame = 0;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let lastSignature = '';

    /**
     * 延迟量测：
     *
     * 真实内容是分阶段出现的（首屏 → 下方区块），刚渲染时高度还是中间态，
     * 立刻量会把「只有 5 块」或「半截高度」写进缓存。所以等布局稳定一段
     * 时间后再量，并用块数与高度的签名去重。
     */
    function scheduleMeasure(): void {
        cancelAnimationFrame(frame);
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(() => {
            frame = requestAnimationFrame(() => {
                const next = measure();
                if (next.length === 0 || next.every((height) => height === 0)) return;
                const signature = next.join(',');
                if (signature === lastSignature) return;
                lastSignature = signature;
                heights.value = next;
                write(next);
            });
        }, SETTLE_MS);
    }

    onMounted(() => {
        heights.value = read();
        scheduleMeasure();

        const el = containerRef.value;
        if (!el) return;
        observer = new ResizeObserver(() => scheduleMeasure());
        observer.observe(el);
    });

    // KeepAlive 下再次进入不会重跑 onMounted，但内容可能因筛选变化而变高
    onActivated(() => scheduleMeasure());

    watch(containerRef, (el) => {
        observer?.disconnect();
        if (!el) return;
        observer?.observe(el);
        scheduleMeasure();
    });

    onBeforeUnmount(() => {
        cancelAnimationFrame(frame);
        if (settleTimer) clearTimeout(settleTimer);
        observer?.disconnect();
        observer = null;
    });

    return { heights };
}
