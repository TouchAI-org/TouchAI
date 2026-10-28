// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * 消息列表有界挂载。
 *
 * 只渲染视口附近的消息，其余用 spacer 占位；高度由 ResizeObserver 实时测量并按消息 id
 * 缓存（宽度/字体/内容变化都会触发重新测量）。向前插入历史页时按新增高度补偿 scrollTop，
 * 保持用户正在阅读的位置不跳动。
 */

import { computed, onUnmounted, type Ref, ref, watch } from 'vue';

import type { SessionMessage } from '@/types/session';

import {
    buildHeightOffsets,
    computeAboveViewportHeightDelta,
    computeMessageWindow,
} from '../messageWindowing';

const DEFAULT_ESTIMATE_HEIGHT = 140;
const DEFAULT_OVERSCAN_PX = 600;
/** 钉住目标消息的最长时间；正常跳转在下一帧就会释放。 */
const PIN_TIMEOUT_MS = 2000;

export interface UseMessageWindowingOptions {
    container: Ref<HTMLElement | null>;
    messages: Ref<readonly SessionMessage[]>;
    /** 关闭时退化为全量渲染（短会话、测量不可用）。 */
    enabled: Ref<boolean>;
    scrollTop: Ref<number>;
    clientHeight: Ref<number>;
    estimateHeight?: (message: SessionMessage) => number;
    overscanPx?: number;
    /**
     * 即将程序性地调整 `scrollTop` 前回调。
     *
     * 容器需要据此区分「用户滚动」与「布局修正」，否则高度补偿产生的滚动事件
     * 会被误当成用户回到顶部/底部，从而错误地开关自动跟随。
     */
    onProgrammaticScroll?: () => void;
}

export function useMessageWindowing(options: UseMessageWindowingOptions) {
    const measuredHeights = new Map<string, number>();
    const version = ref(0);
    const pinnedMessageId = ref<string | null>(null);
    const observedTargets = new Map<HTMLElement, () => void>();
    let itemObserver: ResizeObserver | null = null;
    let containerObserver: ResizeObserver | null = null;
    let pinTimer: ReturnType<typeof setTimeout> | null = null;
    let measureFrame: number | null = null;
    const pendingMeasureTargets = new Set<HTMLElement>();

    const heights = computed(() => {
        void version.value;
        return options.messages.value.map(
            (message) => measuredHeights.get(message.id) ?? estimateFor(message)
        );
    });
    const offsets = computed(() => buildHeightOffsets(heights.value));
    const totalHeight = computed(() => offsets.value[offsets.value.length - 1] ?? 0);

    const windowRange = computed(() => {
        if (!options.enabled.value) {
            return {
                start: 0,
                end: options.messages.value.length,
                topSpacer: 0,
                bottomSpacer: 0,
            };
        }

        const pinnedId = pinnedMessageId.value;
        const pinnedIndex = pinnedId
            ? options.messages.value.findIndex((message) => message.id === pinnedId)
            : -1;

        return computeMessageWindow({
            offsets: offsets.value,
            scrollTop: options.scrollTop.value,
            viewportHeight: options.clientHeight.value,
            overscanPx: options.overscanPx ?? DEFAULT_OVERSCAN_PX,
            pinnedIndex: pinnedIndex >= 0 ? pinnedIndex : null,
        });
    });

    const renderedMessages = computed(() =>
        options.messages.value.slice(windowRange.value.start, windowRange.value.end)
    );

    function estimateFor(message: SessionMessage): number {
        return options.estimateHeight?.(message) ?? DEFAULT_ESTIMATE_HEIGHT;
    }

    function measureElement(element: HTMLElement, message: SessionMessage): void {
        const height = element.offsetHeight;
        if (!(height > 0)) {
            return;
        }

        const messageId = message.id;
        // 首次测量要和“当前估算值”比较：向顶部加载历史页时，新插入的行先按估值
        // 预留了空间，真实高度与估值的差额必须补偿到 scrollTop，否则阅读位置会漂移。
        const previousHeight = measuredHeights.get(messageId) ?? estimateFor(message);
        if (previousHeight === height) {
            return;
        }

        const container = options.container.value;
        const delta = height - previousHeight;
        measuredHeights.set(messageId, height);
        version.value += 1;

        // 视口上方的高度变化需要补偿 scrollTop，避免阅读位置跳动。
        if (container && delta !== 0) {
            const containerTop = container.getBoundingClientRect().top;
            const elementTop = element.getBoundingClientRect().top;
            const aboveDelta = computeAboveViewportHeightDelta(
                [{ top: elementTop, delta }],
                containerTop
            );
            if (aboveDelta !== 0) {
                options.onProgrammaticScroll?.();
                container.scrollTop += aboveDelta;
            }
        }
    }

    function observeMessageElement(element: HTMLElement, message: SessionMessage): void {
        const refresh = () => measureElement(element, message);
        observedTargets.set(element, refresh);
        itemObserver?.observe(element);
        refresh();
    }

    function registerMessageElement(
        message: SessionMessage,
        target: Element | { $el?: Element } | null
    ): void {
        const element =
            target instanceof HTMLElement
                ? target
                : target && '$el' in target && target.$el instanceof HTMLElement
                  ? target.$el
                  : null;
        if (!element) {
            return;
        }

        observeMessageElement(element, message);
    }

    /**
     * 把测量合并到下一帧。
     *
     * RO 回调里直接测量 + 补值 `scrollTop` 会反复中断布局，连成 `ResizeObserver loop`；
     * 合批后一帧只跑一次。
     */
    function scheduleMeasure(element: HTMLElement): void {
        pendingMeasureTargets.add(element);
        if (measureFrame !== null) {
            return;
        }

        measureFrame = requestAnimationFrame(() => {
            measureFrame = null;
            const targets = [...pendingMeasureTargets];
            pendingMeasureTargets.clear();
            for (const target of targets) {
                observedTargets.get(target)?.();
            }
        });
    }

    if (typeof ResizeObserver !== 'undefined') {
        itemObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                if (entry.target instanceof HTMLElement) {
                    scheduleMeasure(entry.target);
                }
            }
        });
    }

    watch(
        options.container,
        (element) => {
            containerObserver?.disconnect();
            containerObserver = null;
            if (!element || typeof ResizeObserver === 'undefined') {
                return;
            }

            // 宽度变化可能改变自动换行行数；重新测量所有已挂载项。
            containerObserver = new ResizeObserver(() => {
                for (const refresh of observedTargets.values()) {
                    refresh();
                }
            });
            containerObserver.observe(element);
        },
        { immediate: true }
    );

    watch(
        () => options.messages.value.map((message) => message.id),
        (nextIds, previousIds) => {
            // 向前插入历史页（新列表后缀等于旧列表）时，按新增项高度补偿 scrollTop。
            const container = options.container.value;
            if (!container || !options.enabled.value || !previousIds?.length) {
                return;
            }

            const firstPreviousId = previousIds[0];
            const anchorIndex = firstPreviousId ? nextIds.indexOf(firstPreviousId) : -1;
            if (anchorIndex <= 0) {
                return;
            }

            const insertedHeight = offsets.value[anchorIndex] ?? 0;
            if (insertedHeight > 0) {
                options.onProgrammaticScroll?.();
                container.scrollTop += insertedHeight;
            }
        },
        { flush: 'post' }
    );

    /** 目标消息在列表内容坐标系中的顶部偏移；用于虚拟化后仍能跳转到未挂载消息。 */
    function messageOffsetTop(messageId: string): number | null {
        const index = options.messages.value.findIndex((message) => message.id === messageId);
        if (index < 0) {
            return null;
        }

        return offsets.value[index] ?? null;
    }

    /**
     * 把指定消息钉进渲染区间。
     *
     * 时间轴跳转的目标可能不在当前窗口内，只有先渲染出来才能拿到真实高度，
     * 否则按估值累加定位会越来越偏。超时自动释放，避免任何情况下窗口卡在钉住状态。
     */
    function pinMessage(messageId: string, timeoutMs = PIN_TIMEOUT_MS): void {
        pinnedMessageId.value = messageId;
        if (pinTimer !== null) {
            clearTimeout(pinTimer);
        }
        pinTimer = setTimeout(() => {
            pinTimer = null;
            pinnedMessageId.value = null;
        }, timeoutMs);
    }

    /** 释放钉住状态（跳转定位完成后调用）。 */
    function releasePin(): void {
        if (pinTimer !== null) {
            clearTimeout(pinTimer);
            pinTimer = null;
        }
        pinnedMessageId.value = null;
    }

    onUnmounted(() => {
        if (pinTimer !== null) {
            clearTimeout(pinTimer);
            pinTimer = null;
        }
        if (measureFrame !== null) {
            cancelAnimationFrame(measureFrame);
            measureFrame = null;
        }
        pendingMeasureTargets.clear();
        itemObserver?.disconnect();
        containerObserver?.disconnect();
        observedTargets.clear();
    });

    return {
        windowRange,
        renderedMessages,
        totalHeight,
        registerMessageElement,
        messageOffsetTop,
        pinMessage,
        releasePin,
    };
}
