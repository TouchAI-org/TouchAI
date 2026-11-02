/**
 * 跳转落点计算。
 *
 * 虚拟列表对未挂载条目只有估算高度，"算一次就跳"必然不准。可靠做法是：
 * 先估算跳一次让目标挂载，随后**按元素实测位置**在有限窗口内持续对齐，
 * 偏差 ≤1px 时不做任何写入（写入本身会触发重排）。
 *
 * 对齐语义与上游 `MessageScroller.scrollToItem` 一致：
 * - `start`：元素顶部距容器顶部 = gap
 * - `center`：元素在视口垂直居中（目标比视口高时降级为 start）
 * - `end`：元素底部距容器底部 = gap
 */

export type NavigationAlign = 'start' | 'center' | 'end';

/** 一次跳转的期望落点。 */
export interface NavigationTarget {
    /** 目标消息 id。 */
    id: string;
    align: NavigationAlign;
    /** 距容器边缘的留白（px）。 */
    gap: number;
}

/** 允许的落点误差；小于该值不做写入，避免亚像素抖动被放大成持续重排。 */
export const NAVIGATION_TOLERANCE_PX = 1;

/**
 * 目标比视口还高时，居中对齐毫无意义（用户会看到消息中部），降级为顶部对齐。
 *
 * @param align 请求的对齐方式。
 * @param itemHeight 目标高度。
 * @param viewportHeight 视口高度。
 * @returns 实际使用的对齐方式。
 */
export function resolveEffectiveAlign(
    align: NavigationAlign,
    itemHeight: number,
    viewportHeight: number
): NavigationAlign {
    if (align === 'center' && itemHeight > viewportHeight) {
        return 'start';
    }

    return align;
}

/**
 * 计算目标元素顶部应该距离容器顶部多少像素。
 *
 * @param align 对齐方式。
 * @param gap 留白。
 * @param itemHeight 目标高度。
 * @param viewportHeight 视口高度。
 * @returns 期望的顶部偏移。
 */
export function resolveDesiredOffset(
    align: NavigationAlign,
    gap: number,
    itemHeight: number,
    viewportHeight: number
): number {
    const effective = resolveEffectiveAlign(align, itemHeight, viewportHeight);

    if (effective === 'center') {
        return (viewportHeight - itemHeight) / 2;
    }

    if (effective === 'end') {
        return viewportHeight - itemHeight - gap;
    }

    return gap;
}

/**
 * 计算还需要补的滚动量。
 *
 * @param currentOffset 目标元素当前相对容器的顶部偏移。
 * @param desiredOffset 期望的顶部偏移。
 * @returns 需要补的 `scrollTop` 增量；已到位时为 0。
 */
export function resolveNavigationCorrection(currentOffset: number, desiredOffset: number): number {
    const delta = currentOffset - desiredOffset;

    return Math.abs(delta) > NAVIGATION_TOLERANCE_PX ? delta : 0;
}
