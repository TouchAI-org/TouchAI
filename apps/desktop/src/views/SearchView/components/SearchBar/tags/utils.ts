import type { DecorationWithType } from '@tiptap/core';

/**
 * 检查装饰列表中是否包含范围选区高亮装饰。
 * 供标签 Vue 组件判断自身是否处于框选范围内。
 */
export function hasRangeSelectedDecoration(decorations: readonly DecorationWithType[]): boolean {
    return (
        decorations?.some((d) => d.type?.attrs?.class?.includes('search-tag-range-selected')) ??
        false
    );
}
