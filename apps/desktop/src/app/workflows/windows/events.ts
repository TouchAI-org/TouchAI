import { AppEvent, type AppEventMap } from '@/app/api/windows/eventContracts';
import { createWindowEvents } from '@/platform/windows/events';

export * from '@/app/api/windows/eventContracts';
export const eventService = createWindowEvents<AppEventMap>({
    subscribe: Object.values(AppEvent),
    publish: Object.values(AppEvent),
});
