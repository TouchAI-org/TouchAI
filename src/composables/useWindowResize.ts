// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { native } from '@services/NativeService';
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
    // 预加载 popup 时窗口默认保持隐藏；这里只允许在外部显式请求后，于下一次 resize 完成时再显示。
    let shouldShowWindowAfterResize = false;
    // PopupView 要等窗口真正显示后，才能把“显示后该做什么”交给具体 popup 组件处理。
    let notifyWindowShown: (() => void) | null = null;

    function markWindowShown() {
        notifyWindowShown?.();
        notifyWindowShown = null;
    }

    async function resize(pageHeight: number) {
        const clamped = Math.max(minHeight, Math.min(pageHeight, maxHeight));
        const newHeight = Math.ceil(clamped);

        if (newHeight === currentHeight.value) return;

        // 目标高度与居中策略都交由 Rust 侧执行，确保不同入口行为一致。
        await native.window.resizeWindowHeight({
            targetHeight: newHeight,
            center,
        });

        // popup 窗口等内容高度稳定后再显示，避免预加载窗口先闪出来。
        if (!isMainWindow && shouldShowWindowAfterResize) {
            await getCurrentWindow().show();
            shouldShowWindowAfterResize = false;
            markWindowShown();
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
        shouldShowWindowAfterResize = true;
        const windowShownPromise = isMainWindow
            ? Promise.resolve()
            : new Promise<void>((resolve) => {
                  notifyWindowShown = resolve;
              });
        const el = options.target.value;
        if (el) {
            nextTick(() => triggerResize(el)).catch(console.error);
        } else {
            markWindowShown();
        }
        return windowShownPromise;
    }

    onUnmounted(cleanup);

    return {
        currentHeight,
        invalidate,
        cancelScheduledWindowShow: () => {
            shouldShowWindowAfterResize = false;
            markWindowShown();
        },
    };
}
