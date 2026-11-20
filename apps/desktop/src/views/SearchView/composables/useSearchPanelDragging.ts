import type { Ref } from 'vue';

import { type SearchWindowApi, useSearchWindowApi } from '@/app/api/windows/presentation';

interface UseSearchPanelDraggingOptions {
    maximized: Readonly<Ref<boolean>>;
    monitorHost?: Readonly<Ref<boolean>>;
    prepareForNativeDrag?: () => Promise<boolean>;
    finishNativeDrag?: () => Promise<void>;
}

/** Bounded hosts move as native windows; the renderer never translates the panel. */
export function useSearchPanelDragging(
    options: UseSearchPanelDraggingOptions,
    searchWindow: SearchWindowApi = useSearchWindowApi()
) {
    let cancelPendingDrag: (() => void) | null = null;

    async function startDragging(event: MouseEvent): Promise<void> {
        if (event.button !== 0 || options.maximized.value || cancelPendingDrag) return;
        let cancelled = false;
        const cancel = () => {
            cancelled = true;
        };
        cancelPendingDrag = cancel;
        window.addEventListener('mouseup', cancel, true);
        window.addEventListener('blur', cancel, true);
        try {
            const prepared = (await options.prepareForNativeDrag?.()) ?? true;
            if (prepared && !cancelled && !options.maximized.value) {
                if (options.monitorHost?.value) await searchWindow.dragSearchWindow();
                else await searchWindow.startDragging();
            }
        } finally {
            window.removeEventListener('mouseup', cancel, true);
            window.removeEventListener('blur', cancel, true);
            cancelPendingDrag = null;
            await options.finishNativeDrag?.();
        }
    }

    function cancelDragging() {
        if (!cancelPendingDrag) return false;
        cancelPendingDrag();
        return true;
    }

    function dispose() {
        cancelDragging();
    }

    return {
        startDragging,
        cancelDragging,
        dispose,
    };
}
