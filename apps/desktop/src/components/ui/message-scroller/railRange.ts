/**
 * 导航轨高亮的区间解析。
 *
 * 一条 turn（用户提问 + 其后的回答）常常跨很多屏：长回答独占 5–10 屏很常见。
 * 因此“当前读到哪里”必须按**内容坐标系的区间重叠**判断，而不是“离视图中心最近的
 * 那个提问元素”——后者会把一整段长回答算成上一条或下一条的位置。
 */

export interface RailRange {
    top: number;
    bottom: number;
}

/**
 * 找出与给定内容偏移重叠的轨道项。
 *
 * @param items 轨道项（按视觉顺序）。
 * @param resolveRange 取某项的内容坐标系区间；无法测量时返回 null。
 * @param offset 内容坐标系中的目标偏移（通常是视图中心）。
 * @returns 命中项的 id；没有可测量区间时返回 null。
 */
export function resolveRailItemAtOffset<T extends { id: string }>(
    items: readonly T[],
    resolveRange: (id: string) => RailRange | null,
    offset: number
): string | null {
    let nearestId: string | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;

    for (const item of items) {
        const range = resolveRange(item.id);
        if (!range) {
            continue;
        }

        if (offset >= range.top && offset <= range.bottom) {
            return item.id;
        }

        const distance = Math.min(Math.abs(offset - range.top), Math.abs(offset - range.bottom));
        if (distance < nearestDistance) {
            nearestDistance = distance;
            nearestId = item.id;
        }
    }

    return nearestId;
}
