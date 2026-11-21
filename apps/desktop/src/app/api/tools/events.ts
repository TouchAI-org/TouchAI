import { createWindowEvents } from '@/platform/windows/events';

import { AppEvent, type AppEventMap } from '../windows/eventContracts';

export * from '../windows/eventContracts';
export const eventService = createWindowEvents<
    Pick<AppEventMap, AppEvent.MCP_STATUS | AppEvent.WEB_SEARCH_ACTIVITY>
>({
    subscribe: [AppEvent.MCP_STATUS, AppEvent.WEB_SEARCH_ACTIVITY],
    publish: [],
});
