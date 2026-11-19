import { createWindowEvents } from '@/platform/windows/events';

import { AppEvent, type AppEventMap } from '../windows/eventContracts';

export * from '../windows/eventContracts';
export const eventService = createWindowEvents<
    Pick<AppEventMap, AppEvent.SESSION_TASK_STATUS_CHANGED>
>({
    subscribe: [AppEvent.SESSION_TASK_STATUS_CHANGED],
    publish: [],
});
