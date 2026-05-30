import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import {
    calculateSettingsSecondarySidebarWidth,
    clampSettingsSecondarySidebarWidth,
    getSettingsSecondarySidebarMaxWidth,
    SETTINGS_PRIMARY_SIDEBAR_RESIZE_EVENT,
    SETTINGS_RESIZE_KEYBOARD_STEP,
    SETTINGS_SECONDARY_PANEL_RESIZE_EVENT,
    SETTINGS_SECONDARY_SIDEBAR_DEFAULT_WIDTH,
    SETTINGS_SECONDARY_SIDEBAR_MIN_WIDTH,
} from '../settingsSidebarLayout';

function readPrimarySidebarWidth(): number | undefined {
    const sidebar = document.querySelector('[data-testid="settings-sidebar"]');
    if (!(sidebar instanceof HTMLElement)) {
        return undefined;
    }

    const width = sidebar.getBoundingClientRect().width;
    if (Number.isFinite(width) && width > 0) {
        return width;
    }

    const inlineWidth = Number.parseFloat(sidebar.style.width);
    return Number.isFinite(inlineWidth) && inlineWidth > 0 ? inlineWidth : undefined;
}

function readPointerId(event: Event): number | null {
    const pointerId = (event as { pointerId?: unknown }).pointerId;

    return typeof pointerId === 'number' ? pointerId : null;
}

export function useSettingsResizablePanel() {
    const panelWidth = ref(SETTINGS_SECONDARY_SIDEBAR_DEFAULT_WIDTH);
    const windowWidth = ref(window.innerWidth);
    const layoutRevision = ref(0);
    const dragStartClientX = ref(0);
    const dragStartWidth = ref(SETTINGS_SECONDARY_SIDEBAR_DEFAULT_WIDTH);
    const activePointerId = ref<number | null>(null);
    const activeResizeTarget = ref<HTMLElement | null>(null);
    const previousBodyCursor = ref('');
    const previousBodyUserSelect = ref('');
    const isResizing = ref(false);

    const getPanelClampOptions = () => ({
        availableWidth: windowWidth.value,
        primarySidebarWidth: readPrimarySidebarWidth(),
    });

    const panelMaxWidth = computed(() => {
        const revision = layoutRevision.value;
        if (revision < 0) {
            return SETTINGS_SECONDARY_SIDEBAR_MIN_WIDTH;
        }

        return getSettingsSecondarySidebarMaxWidth(getPanelClampOptions());
    });

    const panelStyle = computed(() => ({
        width: `${panelWidth.value}px`,
        minWidth: `${SETTINGS_SECONDARY_SIDEBAR_MIN_WIDTH}px`,
        maxWidth: `${panelMaxWidth.value}px`,
    }));

    const notifySecondaryPanelResize = () => {
        window.dispatchEvent(new CustomEvent(SETTINGS_SECONDARY_PANEL_RESIZE_EVENT));
    };

    const applyPanelWidth = (width: number) => {
        const nextWidth = clampSettingsSecondarySidebarWidth(width, getPanelClampOptions());
        if (nextWidth === panelWidth.value) {
            return;
        }

        panelWidth.value = nextWidth;
        notifySecondaryPanelResize();
    };

    const reconcilePanelWidth = () => {
        layoutRevision.value += 1;
        applyPanelWidth(panelWidth.value);
    };

    const handleLayoutResize = () => {
        windowWidth.value = window.innerWidth;
        reconcilePanelWidth();
    };

    const stopResize = () => {
        window.removeEventListener('pointermove', handleResizePointerMove);
        window.removeEventListener('pointerup', handleResizePointerUp);
        window.removeEventListener('pointercancel', handleResizePointerUp);
        window.removeEventListener('blur', handleResizePointerUp);

        const target = activeResizeTarget.value;
        target?.removeEventListener('pointerup', handleResizePointerUp);
        target?.removeEventListener('pointercancel', handleResizePointerUp);
        target?.removeEventListener('lostpointercapture', handleResizePointerUp);

        if (target && activePointerId.value !== null) {
            try {
                target.releasePointerCapture(activePointerId.value);
            } catch {
                // Pointer capture may already be released by the browser.
            }
        }

        if (isResizing.value) {
            document.body.style.cursor = previousBodyCursor.value;
            document.body.style.userSelect = previousBodyUserSelect.value;
        }

        activePointerId.value = null;
        activeResizeTarget.value = null;
        isResizing.value = false;
    };

    const handleResizePointerMove = (event: PointerEvent) => {
        if (activePointerId.value !== null && event.pointerId !== activePointerId.value) {
            return;
        }

        applyPanelWidth(
            calculateSettingsSecondarySidebarWidth(
                dragStartWidth.value,
                dragStartClientX.value,
                event.clientX,
                getPanelClampOptions()
            )
        );
    };

    const handleResizePointerUp = (event?: Event) => {
        const pointerId = event ? readPointerId(event) : null;
        if (
            activePointerId.value !== null &&
            pointerId !== null &&
            pointerId !== activePointerId.value
        ) {
            return;
        }

        stopResize();
    };

    const handleResizeKeyDown = (event: KeyboardEvent) => {
        let nextWidth: number | null = null;

        if (event.key === 'ArrowLeft') {
            nextWidth = panelWidth.value - SETTINGS_RESIZE_KEYBOARD_STEP;
        } else if (event.key === 'ArrowRight') {
            nextWidth = panelWidth.value + SETTINGS_RESIZE_KEYBOARD_STEP;
        } else if (event.key === 'Home') {
            nextWidth = SETTINGS_SECONDARY_SIDEBAR_MIN_WIDTH;
        } else if (event.key === 'End') {
            nextWidth = panelMaxWidth.value;
        }

        if (nextWidth === null) {
            return;
        }

        event.preventDefault();
        applyPanelWidth(nextWidth);
    };

    const handleResizePointerDown = (event: PointerEvent) => {
        if (activePointerId.value !== null) {
            event.preventDefault();
            return;
        }

        if (event.button !== 0) {
            return;
        }

        event.preventDefault();
        const resizeTarget =
            event.currentTarget instanceof HTMLElement ? event.currentTarget : null;

        dragStartClientX.value = event.clientX;
        dragStartWidth.value = panelWidth.value;
        activePointerId.value = event.pointerId;
        activeResizeTarget.value = resizeTarget;
        previousBodyCursor.value = document.body.style.cursor;
        previousBodyUserSelect.value = document.body.style.userSelect;
        isResizing.value = true;

        try {
            resizeTarget?.setPointerCapture(event.pointerId);
        } catch {
            // Pointer capture is a best-effort guard; window listeners still cover normal drags.
        }

        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        window.addEventListener('pointermove', handleResizePointerMove);
        window.addEventListener('pointerup', handleResizePointerUp);
        window.addEventListener('pointercancel', handleResizePointerUp);
        window.addEventListener('blur', handleResizePointerUp);
        resizeTarget?.addEventListener('pointerup', handleResizePointerUp);
        resizeTarget?.addEventListener('pointercancel', handleResizePointerUp);
        resizeTarget?.addEventListener('lostpointercapture', handleResizePointerUp);
    };

    onBeforeUnmount(() => {
        window.removeEventListener('resize', handleLayoutResize);
        window.removeEventListener(SETTINGS_PRIMARY_SIDEBAR_RESIZE_EVENT, handleLayoutResize);
        stopResize();
    });

    onMounted(() => {
        window.addEventListener('resize', handleLayoutResize);
        window.addEventListener(SETTINGS_PRIMARY_SIDEBAR_RESIZE_EVENT, handleLayoutResize);
        reconcilePanelWidth();
        notifySecondaryPanelResize();
    });

    return {
        handleResizeKeyDown,
        handleResizePointerDown,
        panelMaxWidth,
        panelMinWidth: SETTINGS_SECONDARY_SIDEBAR_MIN_WIDTH,
        panelStyle,
        panelWidth,
    };
}
