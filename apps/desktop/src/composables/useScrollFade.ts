// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { computed, type Ref, ref, watch } from 'vue';

export function useScrollFade(containerRef: Ref<HTMLElement | null>, fadeSize = 28) {
    const topFade = ref(0);
    const bottomFade = ref(0);
    const scrollFadeStyle = computed(() => ({
        '--scroll-fade-top': `${topFade.value}px`,
        '--scroll-fade-bottom': `${bottomFade.value}px`,
    }));

    watch(
        containerRef,
        (element, _previous, onCleanup) => {
            topFade.value = 0;
            bottomFade.value = 0;
            if (!element) return;

            const scrollElement = element;
            let frame: number | null = null;

            function update() {
                frame = null;
                const scrollRange = Math.max(
                    0,
                    scrollElement.scrollHeight - scrollElement.clientHeight
                );
                const scrollTop = Math.max(0, Math.min(scrollElement.scrollTop, scrollRange));
                topFade.value = Math.min(fadeSize, scrollTop);
                bottomFade.value = Math.min(fadeSize, scrollRange - scrollTop);
            }

            function scheduleUpdate() {
                if (frame === null) frame = requestAnimationFrame(update);
            }

            const resizeObserver =
                typeof ResizeObserver !== 'undefined' ? new ResizeObserver(scheduleUpdate) : null;

            function observeSizes() {
                resizeObserver?.disconnect();
                resizeObserver?.observe(scrollElement);
                for (const child of scrollElement.children) resizeObserver?.observe(child);
            }

            // Async settings sections can replace their root without resizing the viewport.
            const mutationObserver =
                typeof MutationObserver !== 'undefined'
                    ? new MutationObserver(() => {
                          observeSizes();
                          scheduleUpdate();
                      })
                    : null;

            observeSizes();
            mutationObserver?.observe(scrollElement, { childList: true });
            scrollElement.addEventListener('scroll', scheduleUpdate, { passive: true });
            update();

            onCleanup(() => {
                scrollElement.removeEventListener('scroll', scheduleUpdate);
                resizeObserver?.disconnect();
                mutationObserver?.disconnect();
                if (frame !== null) cancelAnimationFrame(frame);
            });
        },
        { immediate: true, flush: 'post' }
    );

    return { scrollFadeStyle };
}
