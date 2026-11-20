import { createWindowEvents } from '@/platform/windows/events';

import { AppEvent, type AppEventMap } from '../windows/eventContracts';

export * from '../windows/eventContracts';
export const eventService = createWindowEvents<
    Pick<
        AppEventMap,
        | AppEvent.SETTINGS_WINDOW_OPENED
        | AppEvent.SETTINGS_SHOW_UPDATES
        | AppEvent.SHORTCUT_CAPTURE_SYSTEM_KEY
        | AppEvent.AI_MODELS_UPDATED
    >
>({
    subscribe: [
        AppEvent.SETTINGS_WINDOW_OPENED,
        AppEvent.SETTINGS_SHOW_UPDATES,
        AppEvent.SHORTCUT_CAPTURE_SYSTEM_KEY,
        AppEvent.AI_MODELS_UPDATED,
    ],
    publish: [AppEvent.AI_MODELS_UPDATED],
});
