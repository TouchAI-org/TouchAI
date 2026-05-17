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
 * 通用窗口高度自动适应内容。
 * 仅负责观察目标元素高度并请求原生窗口 resize。
 */
export function useWindowResize(options: WindowResizeOptions) {
    const currentWindow = getCurrentWindow();
    const currentHeight = ref(0);
    const isMainWindow = currentWindow.label === 'main';
    const maxHeight = options.maxHeight ?? Infinity;
    const minHeight = options.minHeight ?? 0;
    const center = options.center ?? isMainWindow;

    let resizeObserver: ResizeObserver | null = null;
    let observedElement: HTMLElement | null = null;

    async function resize(pageHeight: number, force = false) {
        const clamped = Math.max(minHeight, Math.min(pageHeight, maxHeight));
        const newHeight = Math.ceil(clamped);

        if (!isMainWindow) {
            const isVisible = await currentWindow.isVisible().catch(() => true);
            if (!isVisible) {
                return;
            }
        }

        if (!force && newHeight === currentHeight.value) {
            return;
        }

        await native.window.resizeWindowHeight({
            targetHeight: newHeight,
            center,
        });
        currentHeight.value = newHeight;
    }

    function measureElementHeight(el: HTMLElement) {
        return Math.max(el.clientHeight, el.scrollHeight);
    }

    function triggerResize(el: HTMLElement) {
        resize(measureElementHeight(el)).catch(console.error);
    }

    function observeTarget(el: HTMLElement) {
        observedElement = el;
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
        observedElement = null;
    }

    watch(
        options.target,
        (el) => {
            cleanup();
            if (el) {
                observeTarget(el);
            }
        },
        { immediate: true }
    );

    onUnmounted(cleanup);

    return {
        currentHeight,
        requestResize: async () => {
            if (observedElement) {
                await resize(measureElementHeight(observedElement), true);
            }
        },
        resetMeasuredHeight: () => {
            currentHeight.value = 0;
        },
    };
}
