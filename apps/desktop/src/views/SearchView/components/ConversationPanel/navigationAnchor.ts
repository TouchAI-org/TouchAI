/** DOM alignment shared by initial navigation and subsequent layout measurements. */

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
