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

export interface UseMessageWindowingOptions {
    container: Ref<HTMLElement | null>;
    messages: Ref<readonly SessionMessage[]>;
    /** 关闭时退化为全量渲染（短会话、测量不可用）。 */
    enabled: Ref<boolean>;
    scrollTop: Ref<number>;
    clientHeight: Ref<number>;
    estimateHeight?: (message: SessionMessage) => number;
    overscanPx?: number;
}

export function useMessageWindowing(options: UseMessageWindowingOptions) {
    const measuredHeights = new Map<string, number>();
    const version = ref(0);
    const observedTargets = new Map<HTMLElement, () => void>();
    let itemObserver: ResizeObserver | null = null;
    let containerObserver: ResizeObserver | null = null;

    const heights = computed(() => {
        void version.value;
        return options.messages.value.map(
            (message) =>
                measuredHeights.get(message.id) ??
                options.estimateHeight?.(message) ??
                DEFAULT_ESTIMATE_HEIGHT
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

        return computeMessageWindow({
            offsets: offsets.value,
            scrollTop: options.scrollTop.value,
            viewportHeight: options.clientHeight.value,
            overscanPx: options.overscanPx ?? DEFAULT_OVERSCAN_PX,
        });
    });

    const renderedMessages = computed(() =>
        options.messages.value.slice(windowRange.value.start, windowRange.value.end)
    );

    function measureElement(element: HTMLElement, messageId: string): void {
        const height = element.offsetHeight;
        if (!(height > 0)) {
            return;
        }

        const previousHeight = measuredHeights.get(messageId) ?? null;
        if (previousHeight === height) {
            return;
        }

        const container = options.container.value;
        const delta = previousHeight === null ? 0 : height - previousHeight;
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
                container.scrollTop += aboveDelta;
            }
        }
    }

    function observeMessageElement(element: HTMLElement, messageId: string): void {
        const refresh = () => measureElement(element, messageId);
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

        observeMessageElement(element, message.id);
    }

    if (typeof ResizeObserver !== 'undefined') {
        itemObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                if (entry.target instanceof HTMLElement) {
                    const refresh = observedTargets.get(entry.target);
                    refresh?.();
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

    onUnmounted(() => {
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
    };
}
