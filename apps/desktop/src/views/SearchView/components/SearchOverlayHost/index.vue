<!-- Copyright (c) 2026. Qian Cheng. Licensed under GPL v3 -->

<script setup lang="ts">
    import { type CSSProperties, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';

    import { SEARCH_OVERLAY_EASING, SEARCH_OVERLAY_MOTION } from '@/config/searchWindow';

    import {
        calculateSearchOverlayPosition,
        type SearchOverlayAlign,
        type SearchOverlayPosition,
        type SearchOverlaySide,
    } from './position';

    defineOptions({ name: 'SearchOverlayHost' });

    interface Props {
        open: boolean;
        reveal?: boolean;
        closeImmediately?: boolean;
        anchor: HTMLElement | null;
        positionAnchor?: HTMLElement | null;
        layoutTarget?: HTMLElement | null;
        preferredSide?: SearchOverlaySide;
        align?: SearchOverlayAlign;
        gap?: number;
        viewportPadding?: number;
        /** Whether the overlay may move to the opposite side of its anchor. */
        allowFlip?: boolean;
        maxViewportHeight?: number;
        minViewportTop?: number;
        /**
         * Element whose left edge the overlay aligns to.
         *
         * A popup that floats over the results list belongs to the surface: it starts on the same
         * vertical line the list does, not on the line of the small control it was opened from (that
         * control is inset) and not on the panel's (the panel is inside the card's padding).
         */
        leftAlignElement?: HTMLElement | null;
        /**
         * Draw the overlay *over* its anchor instead of beside it.
         *
         * A popup that floats over the results list covers the list from its first row: the anchor is
         * the slot the list is drawn in, so the popup takes that slot's top edge rather than the edge
         * below it.
         */
        overlayOnAnchor?: boolean;
    }

    const props = withDefaults(defineProps<Props>(), {
        reveal: true,
        closeImmediately: false,
        positionAnchor: null,
        leftAlignElement: null,
        overlayOnAnchor: false,
        layoutTarget: null,
        preferredSide: 'bottom',
        align: 'start',
        gap: 8,
        viewportPadding: 8,
        allowFlip: false,
    });

    const emit = defineEmits<{
        afterLeave: [];
        outsideClick: [event: PointerEvent];
        positioned: [position: SearchOverlayPosition];
        regionChange: [element: HTMLElement | null];
        revealed: [];
    }>();

    const overlayElement = ref<HTMLElement | null>(null);
    const overlayStyle = ref<CSSProperties>({ visibility: 'hidden' });
    const overlayOrigin = ref('top-left');
    const renderOverlay = ref(props.open);
    const overlayMotionState = ref<'entering' | 'open' | 'closing'>(
        props.open ? 'entering' : 'closing'
    );
    const overlayMotionStyle = {
        '--dropdown-open-dur': `${SEARCH_OVERLAY_MOTION.openDurationMs}ms`,
        '--dropdown-close-dur': `${SEARCH_OVERLAY_MOTION.closeDurationMs}ms`,
        '--dropdown-enter-offset': `${SEARCH_OVERLAY_MOTION.enterOffsetPx}px`,
        '--dropdown-enter-scale': SEARCH_OVERLAY_MOTION.enterScale,
        '--dropdown-closing-scale': SEARCH_OVERLAY_MOTION.closingScale,
        '--dropdown-ease': SEARCH_OVERLAY_EASING,
    } as CSSProperties;
    let resizeObserver: ResizeObserver | null = null;
    let positionFrame: number | null = null;
    let openTransitionFrame: number | null = null;
    let openTransitionToken = 0;
    let closeTimer: ReturnType<typeof setTimeout> | null = null;
    let closeTransitionToken = 0;
    let closeTransitionElement: HTMLElement | null = null;
    let isMounted = false;

    function resolvePositionAnchor() {
        return props.positionAnchor ?? props.anchor;
    }

    function updatePosition() {
        const positionAnchor = resolvePositionAnchor();
        if (!props.open || !props.anchor || !positionAnchor || !overlayElement.value) {
            overlayStyle.value = { visibility: 'hidden' };
            return;
        }

        // Covering a popup takes its box from the element it covers: the slot defines both its left
        // edge and the row it starts on, whatever control the caller anchored to.
        const anchorRect = positionAnchor.getBoundingClientRect();
        const alignmentRect = props.leftAlignElement?.getBoundingClientRect() ?? anchorRect;
        if (props.overlayOnAnchor) {
            const overlayRect = overlayElement.value.getBoundingClientRect();
            const top = Math.max(
                anchorRect.top + props.gap,
                (props.minViewportTop ?? 0) + props.viewportPadding
            );
            overlayStyle.value = {
                left: `${alignmentRect.left}px`,
                top: `${top}px`,
                visibility: props.reveal ? 'visible' : 'hidden',
                '--search-overlay-max-height':
                    props.maxViewportHeight === undefined
                        ? undefined
                        : `${Math.max(0, props.maxViewportHeight - top - props.viewportPadding)}px`,
            };
            overlayOrigin.value = `top-${props.align}`;
            emit('positioned', {
                left: alignmentRect.left,
                top,
                side: 'bottom',
                // Relative to the window's top edge, the same unit the host reserves space in.
                requiredViewportHeight: top + overlayRect.height + (props.viewportPadding ?? 0),
            });
            emit('regionChange', overlayElement.value);
            return;
        }

        const position = calculateSearchOverlayPosition({
            anchor: {
                left: alignmentRect.left,
                right: alignmentRect.right,
                width: alignmentRect.width,
                top: anchorRect.top,
                bottom: anchorRect.bottom,
                height: anchorRect.height,
            },
            overlay: overlayElement.value.getBoundingClientRect(),
            viewport: {
                width: document.documentElement.clientWidth,
                height: document.documentElement.clientHeight,
            },
            preferredSide: props.preferredSide,
            align: props.align,
            gap: props.gap,
            allowFlip: props.allowFlip,
            maxViewportHeight: props.maxViewportHeight,
            minViewportTop: props.minViewportTop,
            viewportPadding: props.viewportPadding,
        });

        overlayStyle.value = {
            left: `${position.left}px`,
            top: `${position.top}px`,
            visibility: props.reveal ? 'visible' : 'hidden',
            '--search-overlay-max-height':
                position.maxHeight === undefined ? undefined : `${position.maxHeight}px`,
        };
        overlayOrigin.value = `${position.side === 'bottom' ? 'top' : 'bottom'}-${props.align}`;
        emit('positioned', position);
        emit('regionChange', overlayElement.value);
    }

    function cancelPositionUpdate() {
        if (positionFrame !== null) {
            cancelAnimationFrame(positionFrame);
            positionFrame = null;
        }
    }

    function cancelOpenTransition() {
        openTransitionToken += 1;
        if (openTransitionFrame !== null) {
            cancelAnimationFrame(openTransitionFrame);
            openTransitionFrame = null;
        }
    }

    function scheduleOpenTransition() {
        cancelOpenTransition();
        overlayMotionState.value = 'entering';
        const token = openTransitionToken;

        void refreshPosition().then(async () => {
            await nextTick();
            if (!isMounted || !props.open || !props.reveal || token !== openTransitionToken) {
                return;
            }

            openTransitionFrame = requestAnimationFrame(async () => {
                openTransitionFrame = null;
                if (!props.open || !props.reveal || token !== openTransitionToken) {
                    return;
                }
                overlayMotionState.value = 'open';
                await nextTick();
                if (isMounted && props.open && props.reveal && token === openTransitionToken) {
                    emit('revealed');
                }
            });
        });
    }

    function cancelCloseTransition() {
        closeTransitionToken += 1;
        if (closeTimer !== null) {
            clearTimeout(closeTimer);
            closeTimer = null;
        }
        closeTransitionElement?.removeEventListener('transitionend', handleCloseTransitionEnd);
        closeTransitionElement = null;
    }

    function handleCloseTransitionEnd(event: TransitionEvent) {
        if (event.target !== closeTransitionElement) {
            return;
        }
        finishCloseTransition(closeTransitionToken);
    }

    function finishCloseTransition(token: number) {
        if (token !== closeTransitionToken || props.open || !isMounted) {
            return;
        }

        if (closeTimer !== null) {
            clearTimeout(closeTimer);
            closeTimer = null;
        }
        closeTransitionElement?.removeEventListener('transitionend', handleCloseTransitionEnd);
        closeTransitionElement = null;
        renderOverlay.value = false;
        overlayStyle.value = { visibility: 'hidden' };
        emit('regionChange', null);
        emit('afterLeave');
    }

    function scheduleCloseTransition() {
        cancelCloseTransition();
        overlayMotionState.value = 'closing';
        const token = closeTransitionToken;

        void nextTick().then(() => {
            if (!isMounted || props.open || token !== closeTransitionToken) {
                return;
            }

            const motionElement = overlayElement.value?.querySelector<HTMLElement>(
                '[data-search-overlay-motion="true"]'
            );
            if (!motionElement) {
                finishCloseTransition(token);
                return;
            }

            const reducedMotion =
                typeof window.matchMedia === 'function' &&
                window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            if (reducedMotion) {
                requestAnimationFrame(() => finishCloseTransition(token));
                return;
            }

            closeTransitionElement = motionElement;
            motionElement.addEventListener('transitionend', handleCloseTransitionEnd);
            closeTimer = setTimeout(
                () => finishCloseTransition(token),
                SEARCH_OVERLAY_MOTION.closeDurationMs
            );
        });
    }

    function schedulePositionUpdate() {
        if (!isMounted || !props.open) {
            return;
        }

        cancelPositionUpdate();
        positionFrame = requestAnimationFrame(() => {
            positionFrame = null;
            updatePosition();
        });
    }

    function observePositionTargets() {
        resizeObserver?.disconnect();
        resizeObserver = null;

        const positionAnchor = resolvePositionAnchor();
        if (!props.open || !props.anchor || !positionAnchor || !overlayElement.value) {
            return;
        }

        resizeObserver = new ResizeObserver(schedulePositionUpdate);
        resizeObserver.observe(props.anchor);
        if (positionAnchor !== props.anchor) {
            resizeObserver.observe(positionAnchor);
        }
        resizeObserver.observe(overlayElement.value);
        if (
            props.layoutTarget &&
            props.layoutTarget !== props.anchor &&
            props.layoutTarget !== positionAnchor
        ) {
            resizeObserver.observe(props.layoutTarget);
        }
    }

    // Call when layout moves the anchor without resizing it.
    async function refreshPosition() {
        if (!props.open) {
            return;
        }

        await nextTick();
        if (!isMounted || !props.open) {
            return;
        }

        observePositionTargets();
        // Explicit refreshes are used after the native host has been resized.
        // Apply the measurement before resolving so callers cannot reveal an
        // overlay at the previous, clamped position.
        updatePosition();
    }

    function handleDocumentPointerDown(event: PointerEvent) {
        if (!props.open) {
            return;
        }

        const target = event.target;
        if (!(target instanceof Node)) {
            return;
        }

        if (overlayElement.value?.contains(target) || props.anchor?.contains(target)) {
            return;
        }

        emit('outsideClick', event);
    }

    watch(
        () => props.open,
        (open) => {
            if (!open) {
                cancelOpenTransition();
                resizeObserver?.disconnect();
                cancelPositionUpdate();
                if (props.closeImmediately) {
                    finishCloseTransition(closeTransitionToken);
                    return;
                }
                scheduleCloseTransition();
                return;
            }

            cancelCloseTransition();
            renderOverlay.value = true;
            overlayMotionState.value = 'entering';
            void nextTick().then(() => {
                if (!isMounted || !props.open) {
                    return;
                }
                if (props.reveal) {
                    scheduleOpenTransition();
                } else {
                    void refreshPosition();
                }
            });
        },
        { flush: 'post' }
    );

    watch(
        () => props.reveal,
        (reveal) => {
            if (!reveal) {
                cancelOpenTransition();
                overlayStyle.value = { ...overlayStyle.value, visibility: 'hidden' };
                return;
            }

            if (props.open) {
                scheduleOpenTransition();
            }
        },
        { flush: 'post' }
    );

    watch(
        () => [
            props.anchor,
            props.positionAnchor,
            props.leftAlignElement,
            props.overlayOnAnchor,
            props.allowFlip,
            props.layoutTarget,
            props.preferredSide,
            props.align,
            props.gap,
            props.viewportPadding,
            props.maxViewportHeight,
            props.minViewportTop,
        ],
        () => {
            if (props.open) {
                void refreshPosition();
            }
        },
        { flush: 'post' }
    );

    onMounted(() => {
        isMounted = true;
        document.addEventListener('pointerdown', handleDocumentPointerDown, true);
        window.addEventListener('resize', schedulePositionUpdate);
        window.addEventListener('scroll', schedulePositionUpdate, true);
        observePositionTargets();
        schedulePositionUpdate();
        if (props.open && props.reveal) {
            scheduleOpenTransition();
        }
    });

    onUnmounted(() => {
        isMounted = false;
        document.removeEventListener('pointerdown', handleDocumentPointerDown, true);
        window.removeEventListener('resize', schedulePositionUpdate);
        window.removeEventListener('scroll', schedulePositionUpdate, true);
        resizeObserver?.disconnect();
        cancelPositionUpdate();
        cancelOpenTransition();
        cancelCloseTransition();
        emit('regionChange', null);
    });

    defineExpose({ refreshPosition });
</script>

<template>
    <div
        v-if="renderOverlay"
        ref="overlayElement"
        class="fixed inline-block"
        style="z-index: 10000"
        :style="overlayStyle"
        :data-motion-state="overlayMotionState"
        data-search-overlay-host="true"
    >
        <div
            class="t-dropdown"
            :data-motion-state="overlayMotionState"
            :data-origin="overlayOrigin"
            data-search-overlay-motion="true"
            :style="overlayMotionStyle"
        >
            <slot />
        </div>
    </div>
</template>

<style scoped>
    [data-search-overlay-host='true']:not([data-motion-state='open']) {
        pointer-events: none;
    }

    .t-dropdown {
        transform-origin: top left;
        transform: translateY(calc(-1 * var(--dropdown-enter-offset)))
            scale(var(--dropdown-enter-scale));
        overflow: visible;
        opacity: 0;
        pointer-events: auto;
        transition:
            transform var(--dropdown-open-dur) var(--dropdown-ease),
            opacity var(--dropdown-open-dur) var(--dropdown-ease);
        animation: none;
    }

    .t-dropdown[data-origin='top-end'] {
        transform-origin: top right;
    }

    .t-dropdown[data-origin='top-center'] {
        transform-origin: top center;
    }

    .t-dropdown[data-origin='bottom-start'] {
        transform: translateY(var(--dropdown-enter-offset)) scale(var(--dropdown-enter-scale));
        transform-origin: bottom left;
    }

    .t-dropdown[data-origin='bottom-center'] {
        transform: translateY(var(--dropdown-enter-offset)) scale(var(--dropdown-enter-scale));
        transform-origin: bottom center;
    }

    .t-dropdown[data-origin='bottom-end'] {
        transform: translateY(var(--dropdown-enter-offset)) scale(var(--dropdown-enter-scale));
        transform-origin: bottom right;
    }

    .t-dropdown[data-motion-state='entering'] {
        transition: none;
    }

    .t-dropdown[data-motion-state='open'] {
        transform: none;
        opacity: 1;
    }

    .t-dropdown[data-motion-state='closing'] {
        transform: scale(var(--dropdown-closing-scale));
        opacity: 0;
        pointer-events: none;
        transition:
            transform var(--dropdown-close-dur) var(--dropdown-ease),
            opacity var(--dropdown-close-dur) var(--dropdown-ease);
    }

    @media (prefers-reduced-motion: reduce) {
        .t-dropdown {
            transition: none !important;
        }
    }
</style>
