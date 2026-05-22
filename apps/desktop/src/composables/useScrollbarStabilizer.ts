// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { onUnmounted, type Ref, watch } from 'vue';

/**
 * 滚动条防抖动
 * 当滚动条出现/消失时，通过动态补偿 padding-right 避免内容水平抖动。
 * 无滚动条时在原有 padding 基础上追加滚动条宽度，有滚动条时恢复原始值。
 */
export function useScrollbarStabilizer(containerRef: Ref<HTMLElement | null>) {
    let observer: ResizeObserver | null = null;
    let scrollbarWidth = 0;
    let basePaddingRight = 0;
    let hadScrollbar: boolean | null = null;

    function measureScrollbarWidth(el: HTMLElement): number {
        const prev = el.style.overflowY;
        el.style.overflowY = 'scroll';
        const w = el.offsetWidth - el.clientWidth;
        el.style.overflowY = prev;
        return w;
    }

    function update(el: HTMLElement) {
        const has = el.scrollHeight > el.clientHeight;
        if (has === hadScrollbar) return;
        hadScrollbar = has;

        if (has) {
            // 滚动条出现，恢复原始 padding
            el.style.paddingRight = '';
        } else {
            // 滚动条消失，补偿 = 原始 padding + 滚动条宽度
            if (scrollbarWidth > 0) {
                el.style.paddingRight = `${basePaddingRight + scrollbarWidth}px`;
            }
        }
    }

    function setup(el: HTMLElement) {
        cleanup();

        // 测量滚动条宽度
        scrollbarWidth = measureScrollbarWidth(el);
        // 读取 CSS 类定义的原始 padding-right（清除可能残留的 inline style 后读取）
        el.style.paddingRight = '';
        basePaddingRight = parseFloat(getComputedStyle(el).paddingRight) || 0;
        hadScrollbar = null;

        observer = new ResizeObserver(() => update(el));
        observer.observe(el);
        // 观察直接子元素以捕获内容高度变化
        for (const child of el.children) {
            observer.observe(child);
        }

        update(el);
    }

    function cleanup() {
        observer?.disconnect();
        observer = null;
        hadScrollbar = null;
        if (containerRef.value) {
            containerRef.value.style.paddingRight = '';
        }
    }

    watch(
        containerRef,
        (el) => {
            if (el) setup(el);
            else cleanup();
        },
        { immediate: true }
    );

    onUnmounted(cleanup);
}
