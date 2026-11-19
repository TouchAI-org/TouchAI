import { onMounted, onUnmounted, shallowRef } from 'vue';

import { log } from '@/app/api/diagnostics';
import { useUpdatesApi } from '@/app/api/updates';

export function useAppUpdateState() {
    const updates = useUpdatesApi();
    const updateState = shallowRef(updates.getState());
    let unsubscribe: (() => void) | null = null;

    onMounted(() => {
        unsubscribe = updates.subscribe((state) => {
            updateState.value = state;
        });

        void updates.initialize().catch((error) => {
            log.warn('[AppUpdateService] Failed to initialize update state:', error);
        });
    });

    onUnmounted(() => {
        unsubscribe?.();
    });

    return updateState;
}
