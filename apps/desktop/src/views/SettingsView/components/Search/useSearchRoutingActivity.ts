import { onMounted, onScopeDispose, type Ref, ref, watch } from 'vue';

import { log } from '@/app/api/diagnostics';
import { AppEvent, eventService } from '@/app/api/tools/events';
import type { WebSearchActivityEvent } from '@/app/api/windows/eventContracts';

export function useSearchRoutingActivity(enabled: Readonly<Ref<boolean>>) {
    const activities = ref<WebSearchActivityEvent[]>([]);
    const expiry = new Map<string, ReturnType<typeof setTimeout>>();
    let disposed = false;
    let unlisten: (() => void) | undefined;

    function remove(id: string) {
        clearTimeout(expiry.get(id));
        expiry.delete(id);
        activities.value = activities.value.filter((activity) => activity.id !== id);
    }
    function clear() {
        for (const timer of expiry.values()) clearTimeout(timer);
        expiry.clear();
        activities.value = [];
    }

    onMounted(async () => {
        try {
            const stop = await eventService.on(AppEvent.WEB_SEARCH_ACTIVITY, (activity) => {
                if (disposed || !enabled.value) return;
                if (activity.phase === 'stopped') {
                    remove(activity.id);
                    return;
                }
                const index = activities.value.findIndex((entry) => entry.id === activity.id);
                if (index >= 0) activities.value[index] = activity;
                else {
                    if (activities.value.length >= 12) remove(activities.value[0]!.id);
                    activities.value.push(activity);
                }
                clearTimeout(expiry.get(activity.id));
                const lifetime =
                    activity.phase === 'searching'
                        ? Math.min(300000, Math.max(1000, activity.timeoutMs)) + 2000
                        : 10000;
                expiry.set(
                    activity.id,
                    setTimeout(() => remove(activity.id), lifetime)
                );
            });
            if (disposed) stop();
            else unlisten = stop;
        } catch (error) {
            log.warn('[SearchSettings] Live search animation unavailable', error);
        }
    });
    watch(enabled, (value) => {
        if (!value) clear();
    });
    onScopeDispose(() => {
        disposed = true;
        unlisten?.();
        clear();
    });
    return { activities, remove };
}
