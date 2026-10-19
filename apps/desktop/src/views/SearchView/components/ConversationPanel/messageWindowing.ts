// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * 消息列表窗口计算。
 *
 * 只渲染视口附近的消息，其余用上下 spacer 占位；高度按「宽度桶 + 字体 + 内容 revision」
 * 缓存，未测量时先用估算高度，测量后替换。
 */

export interface MessageWindowRange {
    /** 渲染区间 [start, end)。 */
    start: number;
    end: number;
    topSpacer: number;
    bottomSpacer: number;
}

/** 生成前缀和偏移：`offsets[i]` 为第 i 项之前的累计高度，长度为 `heights.length + 1`。 */
export function buildHeightOffsets(heights: readonly number[]): number[] {
    const offsets = new Array<number>(heights.length + 1);
    offsets[0] = 0;
    for (let index = 0; index < heights.length; index += 1) {
        offsets[index + 1] = offsets[index]! + Math.max(0, heights[index]!);
    }
    return offsets;
}

/** 二分查找累计偏移 <= `offset` 的最后一项。 */
export function findWindowStart(offsets: readonly number[], offset: number): number {
    if (offsets.length <= 1) {
        return 0;
    }

    let low = 0;
    let high = offsets.length - 1;
    while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (offsets[mid]! <= offset) {
            low = mid;
        } else {
            high = mid - 1;
        }
    }

    return low;
}

/** 计算需要渲染的消息区间与上下占位高度。 */
export function computeMessageWindow(options: {
    offsets: readonly number[];
    scrollTop: number;
    viewportHeight: number;
    overscanPx?: number;
}): MessageWindowRange {
    const count = options.offsets.length - 1;
    if (count <= 0) {
        return { start: 0, end: 0, topSpacer: 0, bottomSpacer: 0 };
    }

    const overscan = Math.max(0, options.overscanPx ?? 600);
    const top = Math.max(0, options.scrollTop);
    const bottom = top + Math.max(0, options.viewportHeight);

    const start = Math.min(
        count - 1,
        findWindowStart(options.offsets, Math.max(0, top - overscan))
    );
    let end = start + 1;
    while (end < count && options.offsets[end]! < bottom + overscan) {
        end += 1;
    }

    return {
        start,
        end,
        topSpacer: options.offsets[start]!,
        bottomSpacer: Math.max(0, options.offsets[count]! - options.offsets[end]!),
    };
}

/** 测量批次内位于视口上方的项，返回总高度变化量，用于补偿 scrollTop。 */
export function computeAboveViewportHeightDelta(
    changes: readonly { top: number; delta: number }[],
    viewportTop: number
): number {
    return changes.reduce(
        (sum, change) => (change.top < viewportTop ? sum + change.delta : sum),
        0
    );
}
