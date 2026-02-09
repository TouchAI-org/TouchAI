// Copyright (c) 2025. 千诚. Licensed under GPL v3

import { LogicalPosition, LogicalSize } from '@tauri-apps/api/dpi';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { nextTick, onUnmounted, type Ref, ref, watch } from 'vue';

interface WindowResizeOptions {
    /** 要观察高度变化的元素 */
    target: Ref<HTMLElement | null>;
    /** 最大窗口高度（逻辑像素） */
    maxHeight?: number;
    /** 最小窗口高度（逻辑像素） */
    minHeight?: number;
    /** resize 时是否保持窗口垂直居中 */
    center?: boolean;
}

/*
 * 窗口高度自动适应内容
 */
export function useWindowResize(options: WindowResizeOptions) {
    const currentHeight = ref(0);
    const isMainWindow = getCurrentWindow().label === 'main';

    const maxHeight = options.maxHeight ?? Infinity;
    const minHeight = options.minHeight ?? 0;
    const center = options.center ?? isMainWindow;

    let resizeObserver: ResizeObserver | null = null;
    // 弹窗窗口：仅在 invalidate() 触发后的首次 resize 才 show，避免 preload 时就显示
    let pendingShow = false;

    async function resize(pageHeight: number) {
        const clamped = Math.max(minHeight, Math.min(pageHeight, maxHeight));
        const newHeight = Math.ceil(clamped);

        if (newHeight === currentHeight.value) return;

        const win = getCurrentWindow();
        const scaleFactor = await win.scaleFactor();

        if (center) {
            const pos = await win.outerPosition();
            const size = await win.innerSize();

            const logicalX = pos.x / scaleFactor;
            const logicalY = pos.y / scaleFactor;
            const logicalCurrentHeight = size.height / scaleFactor;

            const newY = logicalY - (newHeight - logicalCurrentHeight) / 2;
            await win.setPosition(new LogicalPosition(logicalX, newY));
        }

        const size = await win.innerSize();
        const logicalWidth = size.width / scaleFactor;
        await win.setSize(new LogicalSize(logicalWidth, newHeight));

        // 弹窗窗口在 Rust 侧不主动 show，等 invalidate 触发的 resize 完成后再显示
        if (!isMainWindow && pendingShow) {
            await win.show();
            pendingShow = false;
        }

        currentHeight.value = newHeight;
    }

    function triggerResize(el: HTMLElement) {
        resize(el.clientHeight).catch(console.error);
    }

    function observeTarget(el: HTMLElement) {
        resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.target.clientHeight;
                resize(height).catch(console.error);
            }
        });
        resizeObserver.observe(el);

        if (document.readyState === 'complete') {
            triggerResize(el);
        } else {
            window.addEventListener('load', () => triggerResize(el), { once: true });
        }
    }

    function cleanup() {
        if (resizeObserver) {
            resizeObserver.disconnect();
            resizeObserver = null;
        }
    }

    // 监听 target ref，元素就绪时自动开始观察
    watch(
        options.target,
        (el) => {
            cleanup();
            if (el) observeTarget(el);
        },
        { immediate: true }
    );

    /**
     * 重置缓存高度并强制重新测量，用于外部因素改变了窗口大小后重新同步
     */
    function invalidate() {
        currentHeight.value = 0;
        pendingShow = true;
        const el = options.target.value;
        if (el) {
            nextTick(() => triggerResize(el)).catch(console.error);
        }
    }

    onUnmounted(cleanup);

    return { currentHeight, invalidate };
}
