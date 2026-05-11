// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { native } from '@services/NativeService';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { onUnmounted, type Ref, ref, watch } from 'vue';

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

    async function resize(pageHeight: number) {
        const clamped = Math.max(minHeight, Math.min(pageHeight, maxHeight));
        const newHeight = Math.ceil(clamped);

        if (!isMainWindow) {
            const isVisible = await getCurrentWindow()
                .isVisible()
                .catch(() => true);
            if (!isVisible) {
                return;
            }
        }

        const heightChanged = newHeight !== currentHeight.value;

        if (heightChanged) {
            // 目标高度与居中策略都交由 Rust 侧执行，确保不同入口行为一致。
            await native.window.resizeWindowHeight({
                targetHeight: newHeight,
                center,
            });
            currentHeight.value = newHeight;
        }
    }

    function measureElementHeight(el: HTMLElement) {
        return Math.max(el.clientHeight, el.scrollHeight);
    }

    function triggerResize(el: HTMLElement) {
        resize(measureElementHeight(el)).catch(console.error);
    }

    function observeTarget(el: HTMLElement) {
        resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const target = entry.target as HTMLElement;
                const height = Math.max(
                    entry.borderBoxSize?.[0]?.blockSize ?? target.clientHeight,
                    target.scrollHeight
                );
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

    onUnmounted(cleanup);

    return {
        currentHeight,
        resetMeasuredHeight: () => {
            // popup 已进入关闭链路时，后续隐藏态的 DOM 收缩不应再回写原生窗口；
            // 同时清空缓存高度，确保下次 reopen 即使内容高度相同也会重新校正窗口尺寸。
            currentHeight.value = 0;
        },
    };
}
