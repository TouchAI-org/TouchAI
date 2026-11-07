/**
 * 导航轨的尺寸计算。
 *
 * 约束：轨道**不得超出窗口**。做法是按可用高度均分，条目多时点会变细（视觉上接近
 * 一条渐变条），但每个点仍对应真实位置。
 *
 * 不做“按比例采样成少数几个点”的方案：那会让点与消息不再一一对应，点击目标变得
 * 难以预测，而这里的第一优先级是不溢出且可预测。
 */

/** 舒适的点高度。 */
const PREFERRED_ITEM_SIZE = 14;

export interface RailLayout {
    /** 每个点（格子）的高度（px）。 */
    itemSize: number;
    /** 轨道总高度（px）。 */
    totalHeight: number;
    /** 是否能在可用高度内完整显示。 */
    fitsWindow: boolean;
}

/**
 * 计算导航轨的点尺寸。
 *
 * @param options.itemCount 轨道项数量。
 * @param options.availableHeight 轨道可用高度（容器高度减去上下留白）。
 * @returns 点尺寸与是否适配。
 */
export function resolveRailLayout(options: {
    itemCount: number;
    availableHeight: number;
}): RailLayout {
    const { itemCount, availableHeight } = options;

    if (itemCount <= 0) {
        return { itemSize: PREFERRED_ITEM_SIZE, totalHeight: 0, fitsWindow: true };
    }

    // 还没测量到高度：给舒适值，由容器的 overflow 兜住，不会把页面撑开。
    if (availableHeight <= 0) {
        return {
            itemSize: PREFERRED_ITEM_SIZE,
            totalHeight: PREFERRED_ITEM_SIZE * itemCount,
            fitsWindow: true,
        };
    }

    const itemSize = Math.min(PREFERRED_ITEM_SIZE, availableHeight / itemCount);

    return {
        itemSize,
        totalHeight: itemSize * itemCount,
        fitsWindow: true,
    };
}
