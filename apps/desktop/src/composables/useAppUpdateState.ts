import { appUpdateService } from '@services/AppUpdateService';
import { log } from '@services/ObservabilityService';
import { onMounted, onUnmounted, shallowRef } from 'vue';

export function useAppUpdateState() {
    const updateState = shallowRef(appUpdateService.getState());
    let unsubscribe: (() => void) | null = null;

    onMounted(() => {
        unsubscribe = appUpdateService.subscribe((state) => {
            updateState.value = state;
        });

        void appUpdateService.initialize().catch((error) => {
            log.warn('[AppUpdateService] Failed to initialize update state:', error);
        });
    });

    onUnmounted(() => {
        unsubscribe?.();
    });

    return updateState;
}
