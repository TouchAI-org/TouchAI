import { getCurrentWindow } from '@tauri-apps/api/window';
import type { Editor } from '@tiptap/core';
import type { ShallowRef } from 'vue';

import {
    isBlankEditorAreaTarget,
    isSearchTagDomTarget,
    resolveMouseEventTarget,
} from '../utils/tiptap';

interface UseDraggingOptions {
    editor: ShallowRef<Editor | null>;
    emitDragStart: () => void;
    emitDragEnd: () => void;
}

/**
 * 搜索栏拖拽手势。
 * 负责区分点击与拖拽，并在可拖拽区域触发窗口拖动。
 *
 * @param options 编辑器引用与拖拽态回调。
 * @returns 拖拽相关鼠标事件处理器。
 */
export function useDragging(options: UseDraggingOptions) {
    const { editor, emitDragStart, emitDragEnd } = options;
    // 拖拽结束后置 true，使下一次 editor click 事件被吞掉，
    // 避免拖拽松手时触发不期望的光标定位或标签交互。
    let suppressNextEditorClick = false;
    // 超时句柄，用于在未触发 click 时自动清除抑制标记
    let suppressClickTimeout: ReturnType<typeof setTimeout> | null = null;
    // 允许在文本可选区域附近多少像素内仍视为"文本选择意图"而非"拖拽意图"。
    const textSelectionSlopPx = 8;

    /**
     * 判断鼠标位置是否接近编辑器中可选文本的渲染边界。
     * 用于区分"用户想选中文字"还是"在空白处拖拽窗口"。
     *
     * 步骤：
     * 1. posAtCoords 将屏幕坐标转为文档位置。
     * 2. coordsAtPos 取回该位置对应文字的渲染矩形。
     * 3. 比较鼠标与渲染矩形在水平/垂直方向的距离是否在容差内。
     *
     * @param ed    Tiptap 编辑器实例。
     * @param event 鼠标按下事件。
     * @returns 鼠标在可选文本附近时为 true。
     */

    function isNearSelectableTextBoundary(ed: Editor, event: MouseEvent) {
        const position = ed.view.posAtCoords({
            left: event.clientX,
            top: event.clientY,
        });

        if (!position) {
            return false;
        }

        let coords: {
            left: number;
            right: number;
            top: number;
            bottom: number;
        } | null = null;

        try {
            coords = ed.view.coordsAtPos(position.pos);
        } catch {
            return false;
        }

        if (!coords) {
            return false;
        }

        const withinVerticalSlop =
            event.clientY >= coords.top - textSelectionSlopPx &&
            event.clientY <= coords.bottom + textSelectionSlopPx;

        if (!withinVerticalSlop) {
            return false;
        }

        const horizontalDistance =
            event.clientX < coords.left
                ? coords.left - event.clientX
                : event.clientX > coords.right
                  ? event.clientX - coords.right
                  : 0;

        return horizontalDistance <= textSelectionSlopPx;
    }

    /**
     * 一次性消费"拖拽后抑制点击"标记。
     * 调用方在 click 事件中先调用此方法，若返回 true 则跳过后续点击逻辑。
     *
     * @returns 是否应吞掉本次点击。
     */
    function consumeEditorClickAfterDrag() {
        const shouldSuppress = suppressNextEditorClick;
        suppressNextEditorClick = false;
        // 清除超时，因为 click 已触发
        if (suppressClickTimeout !== null) {
            clearTimeout(suppressClickTimeout);
            suppressClickTimeout = null;
        }
        return shouldSuppress;
    }

    /**
     * 触发窗口拖拽，并在结束后统一回收 UI 拖拽态。
     *
     * @returns Promise<void>
     */
    async function startDragging() {
        emitDragStart();
        try {
            await getCurrentWindow().startDragging();
        } finally {
            // 无论拖拽是否成功触发，都确保 UI 拖拽态被回收。
            setTimeout(() => {
                emitDragEnd();
            }, 100);
        }
    }

    /**
     * 容器层拖拽入口：仅在容器空白区域触发，排除 logo 与子元素交互。
     *
     * @param event 鼠标按下事件。
     * @returns Promise<void>
     */
    async function handleContainerMouseDown(event: MouseEvent) {
        const target = event.target;
        const currentTarget = event.currentTarget;

        if (!(target instanceof HTMLElement) || !(currentTarget instanceof HTMLElement)) {
            return;
        }

        const logoContainer = target.closest('.logo-container');

        if (logoContainer) {
            return;
        }

        // 仅点击容器自身（通常是空白区域）才触发拖拽。
        if (target !== currentTarget) {
            return;
        }

        await startDragging();
    }

    /**
     * 编辑器拖拽入口：编辑器无内容时整体充当拖拽区域。
     * 有内容时不拦截，保留文本编辑体验。
     *
     * @param event 鼠标按下事件。
     * @returns void
     */
    function handleEditorMouseDown(event: MouseEvent) {
        const ed = editor.value;
        if (!ed || event.button !== 0) return;

        const target = resolveMouseEventTarget(event);
        if (!target || isSearchTagDomTarget(target)) {
            return;
        }

        // 编辑器空 → 整块可拖拽；有内容 → 仅空白区域且远离文字时可拖拽。
        const shouldTrackBlankAreaDrag =
            ed.isEmpty ||
            (isBlankEditorAreaTarget(target) && !isNearSelectableTextBoundary(ed, event));
        if (!shouldTrackBlankAreaDrag) {
            return;
        }

        const startX = event.clientX;
        const startY = event.clientY;
        const dragThreshold = 4;
        let dragStarted = false;

        const cleanup = () => {
            window.removeEventListener('mousemove', handleMouseMove, true);
            window.removeEventListener('mouseup', handleMouseUp, true);
        };

        const handleMouseMove = (moveEvent: MouseEvent) => {
            if (dragStarted) {
                return;
            }

            const deltaX = moveEvent.clientX - startX;
            const deltaY = moveEvent.clientY - startY;
            if (Math.hypot(deltaX, deltaY) < dragThreshold) {
                return;
            }

            dragStarted = true;
            suppressNextEditorClick = true;
            // 设置超时：如果 500ms 内没有 click 事件，自动清除抑制标记
            suppressClickTimeout = setTimeout(() => {
                suppressNextEditorClick = false;
                suppressClickTimeout = null;
            }, 500);
            cleanup();
            moveEvent.preventDefault();
            void startDragging();
        };

        const handleMouseUp = () => {
            cleanup();
        };

        window.addEventListener('mousemove', handleMouseMove, true);
        window.addEventListener('mouseup', handleMouseUp, true);
    }

    /**
     * 清理拖拽状态，包括清除超时句柄。
     * 在组件卸载时调用，防止内存泄漏。
     */
    function clearEditorSelectionDragState() {
        if (suppressClickTimeout !== null) {
            clearTimeout(suppressClickTimeout);
            suppressClickTimeout = null;
        }
        suppressNextEditorClick = false;
    }

    return {
        handleContainerMouseDown,
        handleEditorMouseDown,
        consumeEditorClickAfterDrag,
        clearEditorSelectionDragState,
    };
}
