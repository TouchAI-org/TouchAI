import { log } from '@services/ObservabilityService';
import { currentMonitor, getCurrentWindow } from '@tauri-apps/api/window';
import { type Ref, watch } from 'vue';

import type { SearchPanelGeometry, SearchPanelResizeDirection } from '../panelResizeGeometry';
import { resizeSearchHostFrame } from '../panelResizeGeometry';
import type { LogicalSearchPanelSize } from './useSearchWindowResize';

interface UseSearchPanelResizingOptions {
    panel: Ref<HTMLElement | null>;
    enabled: Readonly<Ref<boolean>>;
    allowHeightOverride: Readonly<Ref<boolean>>;
    minimumSize: Readonly<Ref<LogicalSearchPanelSize>>;
    beginResize: () => LogicalSearchPanelSize;
    previewResize: (
        size: LogicalSearchPanelSize,
        physicalOrigin: SearchPanelGeometry['physicalOrigin']
    ) => Promise<unknown>;
    commitResize: () => Promise<unknown>;
    cancelResize: (physicalOrigin?: SearchPanelGeometry['physicalOrigin']) => Promise<unknown>;
    onResizeStart?: () => void;
    onResizeEnd?: () => void;
}

export function useSearchPanelResizing(options: UseSearchPanelResizingOptions) {
    let cancelActiveResize: (() => void) | null = null;
    let activeResizeCompletion: Promise<void> | null = null;

    async function startResizing(
        direction: SearchPanelResizeDirection,
        event: PointerEvent
    ): Promise<void> {
        if (!options.enabled.value || event.button !== 0) return;

        if (!options.panel.value || activeResizeCompletion) return;

        const startSize = options.beginResize();
        // Client coordinates move with north/west resizing; screen coordinates do not.
        const startX = event.screenX;
        const startY = event.screenY;
        const pointerId = event.pointerId;
        const captureTarget =
            event.currentTarget instanceof HTMLElement ? event.currentTarget : null;

        event.preventDefault();
        event.stopPropagation();
        try {
            captureTarget?.setPointerCapture(pointerId);
        } catch {
            // Window-level listeners still keep the resize interaction coherent.
        }
        options.onResizeStart?.();

        let outcome: 'commit' | 'cancel' | null = null;
        let pendingPointer: { x: number; y: number } | null = null;
        let wake: (() => void) | null = null;
        const removeListeners = () => {
            window.removeEventListener('pointermove', handlePointerMove, true);
            window.removeEventListener('pointerup', handlePointerUp, true);
            window.removeEventListener('pointercancel', handlePointerCancel, true);
            window.removeEventListener('keydown', handleKeyDown, true);
            window.removeEventListener('blur', cancel, true);
            captureTarget?.removeEventListener('lostpointercapture', cancel);
        };
        const finish = (next: 'commit' | 'cancel') => {
            outcome = next;
            if (next === 'cancel') pendingPointer = null;
            removeListeners();
            wake?.();
        };
        const cancel = () => finish('cancel');
        const handlePointerMove = (moveEvent: PointerEvent) => {
            if (moveEvent.pointerId !== pointerId) return;
            moveEvent.preventDefault();
            pendingPointer = { x: moveEvent.screenX, y: moveEvent.screenY };
            wake?.();
        };
        const handlePointerUp = (upEvent: PointerEvent) => {
            if (upEvent.pointerId !== pointerId) return;
            pendingPointer = { x: upEvent.screenX, y: upEvent.screenY };
            finish('commit');
        };
        const handlePointerCancel = (cancelEvent: PointerEvent) => {
            if (cancelEvent.pointerId === pointerId) cancel();
        };
        const handleKeyDown = (keyEvent: KeyboardEvent) => {
            if (keyEvent.key !== 'Escape' && keyEvent.key !== 'Esc') return;
            keyEvent.preventDefault();
            keyEvent.stopImmediatePropagation();
            cancel();
        };

        cancelActiveResize = cancel;
        window.addEventListener('pointermove', handlePointerMove, true);
        window.addEventListener('pointerup', handlePointerUp, true);
        window.addEventListener('pointercancel', handlePointerCancel, true);
        window.addEventListener('keydown', handleKeyDown, true);
        window.addEventListener('blur', cancel, true);
        captureTarget?.addEventListener('lostpointercapture', cancel);
        const stopWatching = watch(
            options.enabled,
            (enabled) => {
                if (!enabled) cancel();
            },
            { flush: 'sync' }
        );

        async function run() {
            let physicalOrigin: SearchPanelGeometry['physicalOrigin'] | undefined;
            let rollbackAttempted = false;
            try {
                const currentWindow = getCurrentWindow();
                const [origin, scaleFactor, monitor] = await Promise.all([
                    currentWindow.outerPosition(),
                    currentWindow.scaleFactor(),
                    currentMonitor(),
                ]);
                physicalOrigin = origin;
                if (!monitor || !Number.isFinite(scaleFactor) || scaleFactor <= 0) {
                    throw new Error('Search window display geometry is unavailable');
                }
                const start = { ...startSize, physicalOrigin };
                let applied = start;
                while (outcome !== 'cancel') {
                    if (!pendingPointer) {
                        if (outcome === 'commit') break;
                        await new Promise<void>((resolve) => {
                            wake = resolve;
                        });
                        wake = null;
                        continue;
                    }
                    const point = pendingPointer;
                    pendingPointer = null;
                    const next = resizeSearchHostFrame({
                        start,
                        direction,
                        deltaX: point.x - startX,
                        deltaY: point.y - startY,
                        workArea: monitor.workArea,
                        scaleFactor,
                        minWidth: options.minimumSize.value.width,
                        minHeight: options.minimumSize.value.height,
                        allowHeightOverride: options.allowHeightOverride.value,
                    });
                    if (
                        next.width === applied.width &&
                        next.height === applied.height &&
                        next.physicalOrigin.x === applied.physicalOrigin.x &&
                        next.physicalOrigin.y === applied.physicalOrigin.y
                    )
                        continue;
                    // One native write in flight, one latest target waiting behind it.
                    await options.previewResize(
                        { width: next.width, height: next.height },
                        next.physicalOrigin
                    );
                    applied = next;
                }
                if (outcome === 'cancel') {
                    rollbackAttempted = true;
                    await options.cancelResize(physicalOrigin);
                } else await options.commitResize();
            } catch (error) {
                if (!rollbackAttempted) {
                    try {
                        await options.cancelResize(physicalOrigin);
                    } catch (rollbackError) {
                        log.error(
                            '[SearchView] Failed to restore cancelled resize:',
                            rollbackError
                        );
                    }
                }
                throw error;
            } finally {
                removeListeners();
                stopWatching();
                try {
                    captureTarget?.releasePointerCapture(pointerId);
                } catch {
                    // WebView2 may have released capture before the native update settled.
                }
                cancelActiveResize = null;
                activeResizeCompletion = null;
                options.onResizeEnd?.();
            }
        }
        activeResizeCompletion = run();
        await activeResizeCompletion;
    }

    function cancelResizing() {
        if (!cancelActiveResize && !activeResizeCompletion) return false;
        cancelActiveResize?.();
        return true;
    }

    async function dispose() {
        cancelActiveResize?.();
        await activeResizeCompletion;
    }

    return { startResizing, cancelResizing, dispose };
}
