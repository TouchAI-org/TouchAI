import { createWindowEvents } from '@/platform/windows/events';

import { AppEvent, type AppEventMap } from '../windows/eventContracts';

export * from '../windows/eventContracts';
export type SearchEventMap = Pick<
    AppEventMap,
    | AppEvent.SEARCH_SURFACE_SHOWN
    | AppEvent.SEARCH_SURFACE_HIDDEN
    | AppEvent.SEARCH_SURFACE_PREPARE
    | AppEvent.SEARCH_SURFACE_COMMAND
    | AppEvent.AI_MODELS_UPDATED
    | AppEvent.SESSION_TASK_STATUS_CHANGED
    | AppEvent.SESSION_STATUS_REMINDER_ACTION
>;
export type SearchEventName = keyof SearchEventMap;
export const eventService = createWindowEvents<SearchEventMap>({
    subscribe: [
        AppEvent.SEARCH_SURFACE_SHOWN,
        AppEvent.SEARCH_SURFACE_HIDDEN,
        AppEvent.SEARCH_SURFACE_PREPARE,
        AppEvent.SEARCH_SURFACE_COMMAND,
        AppEvent.AI_MODELS_UPDATED,
        AppEvent.SESSION_TASK_STATUS_CHANGED,
        AppEvent.SESSION_STATUS_REMINDER_ACTION,
    ],
    publish: [],
});
