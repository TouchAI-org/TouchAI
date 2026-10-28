// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * 设置页各分区的滚动位置记忆。
 *
 * 设置页只有一个滚动容器，切换分区时 `scrollTop` 会被沿用，
 * 于是「在通用页滚到底，切到模型页」会直接落在半截位置。这里按分区记住位置，
 * 切回时恢复，且按新内容高度裁剪，避免内容变短后停在空白处。
 */

/** 读取容器当前滚动位置；容器不可用时返回 null。 */
export function readScrollTop(element: { scrollTop: number } | null): number | null {
    return element ? element.scrollTop : null;
}

/**
 * 计算切回某分区时应恢复的滚动位置。
 *
 * @param remembered 该分区上次的滚动位置（未访问过则为 undefined）。
 * @param scrollHeight 新内容的总高度。
 * @param clientHeight 容器可见高度。
 * @returns 裁剪后的 scrollTop。
 */
export function resolveRestoredScrollTop(
    remembered: number | undefined,
    scrollHeight: number,
    clientHeight: number
): number {
    const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
    const target = remembered ?? 0;

    return Math.min(Math.max(0, target), maxScrollTop);
}
