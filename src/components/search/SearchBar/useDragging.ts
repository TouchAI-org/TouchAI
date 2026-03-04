import { getCurrentWindow } from '@tauri-apps/api/window';
import type { Ref } from 'vue';

interface UseDraggingOptions {
    searchInput: Ref<HTMLInputElement | null>;
    emitDragStart: () => void;
    emitDragEnd: () => void;
}

/**
 * 搜索栏拖拽手势。
 * 负责区分点击与拖拽，并在可拖拽区域触发窗口拖动。
 *
 * @param options 输入框引用与拖拽态回调。
 * @returns 拖拽相关鼠标事件处理器。
 */
export function useDragging(options: UseDraggingOptions) {
    const { searchInput, emitDragStart, emitDragEnd } = options;

    // 1. 拖动检测相关状态
    let mouseDownPos: { x: number; y: number } | null = null;
    let mouseDownTime = 0;
    let isDraggingDetected = false;
    const DRAG_THRESHOLD = 5;
    const DRAG_TIME_THRESHOLD = 150;

    // 2. 拖拽启动
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

    // 3. 鼠标事件处理
    /**
     * 容器层拖拽入口：仅在容器空白区域触发，排除 logo 与子元素交互。
     *
     * @param event 鼠标按下事件。
     * @returns Promise<void>
     */
    // 容器层只允许点击容器本体空白区域时发起拖拽，避免劫持子元素交互。
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
     * 输入框拖拽入口：仅在空白区域启用拖拽，保留文本编辑体验。
     * 判断是否是空白区域，以区分是允许用户选择还是按照拖拽窗口事件处理
     *
     * @param event 鼠标按下事件。
     * @returns void
     */
    function handleInputMouseDown(event: MouseEvent) {
        const input = searchInput.value;
        if (!input) return;

        mouseDownPos = { x: event.clientX, y: event.clientY };
        mouseDownTime = Date.now();
        isDraggingDetected = false;

        // 输入框为空时，不需要区分文本区/空白区，直接按拖拽处理。
        if (!input.value) {
            event.preventDefault();
            void startDragging();
            return;
        }

        const rect = input.getBoundingClientRect();
        const clickX = event.clientX - rect.left;

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const style = window.getComputedStyle(input);
        ctx.font = `${style.fontSize} ${style.fontFamily}`;
        const textWidth = ctx.measureText(input.value).width;

        const padding = 10;
        const isBlankArea = clickX > textWidth + padding;

        if (isBlankArea) {
            const handleMouseMove = (e: MouseEvent) => {
                if (!mouseDownPos) return;

                const deltaX = Math.abs(e.clientX - mouseDownPos.x);
                const deltaY = Math.abs(e.clientY - mouseDownPos.y);
                const timeDelta = Date.now() - mouseDownTime;

                if (
                    deltaX > DRAG_THRESHOLD ||
                    deltaY > DRAG_THRESHOLD ||
                    (timeDelta > DRAG_TIME_THRESHOLD && (deltaX > 2 || deltaY > 2))
                ) {
                    isDraggingDetected = true;
                    document.removeEventListener('mousemove', handleMouseMove);
                    document.removeEventListener('mouseup', handleMouseUp);
                    event.preventDefault();
                    void startDragging();
                }
            };

            const handleMouseUp = () => {
                document.removeEventListener('mousemove', handleMouseMove);
                document.removeEventListener('mouseup', handleMouseUp);

                if (!isDraggingDetected && input) {
                    input.setSelectionRange(input.value.length, input.value.length);
                    input.focus();
                }

                mouseDownPos = null;
                isDraggingDetected = false;
            };

            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);

            event.preventDefault();
        }
    }

    return {
        handleContainerMouseDown,
        handleInputMouseDown,
    };
}
