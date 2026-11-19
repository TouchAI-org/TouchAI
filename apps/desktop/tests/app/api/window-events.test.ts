import { emit } from '@tauri-apps/api/event';
import { getTauriInvokeCalls, interceptTauriInvoke } from '@tests/utils/tauri';
import { describe, expect, it } from 'vitest';

import { AppEvent, eventService as searchEvents } from '@/app/api/search/events';
import { eventService as settingsEvents } from '@/app/api/settings/events';
import { eventService as toolsEvents } from '@/app/api/tools/events';

describe('given window event clients with declared topics', () => {
    it('user given a Search subscription when leaving then receives no later native status', async () => {
        const received: unknown[] = [];
        const stop = await searchEvents.on(AppEvent.SEARCH_SURFACE_HIDDEN, (event) =>
            received.push(event)
        );
        const payload = { sequence: 1, reason: 'manual-dismiss' as const };
        await emit(AppEvent.SEARCH_SURFACE_HIDDEN, payload);
        stop();
        await emit(AppEvent.SEARCH_SURFACE_HIDDEN, { ...payload, sequence: 2 });
        expect(received).toEqual([payload]);
    });

    it.each([searchEvents, settingsEvents, toolsEvents])(
        'user given an unrelated topic when casting a window client then cannot publish or subscribe to it',
        async (client) => {
            const unknown = 'unrelated:topic' as never;
            await expect(client.emit(unknown, {} as never)).rejects.toThrow(
                'WINDOW_EVENT_UNAVAILABLE'
            );
            await expect(client.on(unknown, () => undefined)).rejects.toThrow(
                'WINDOW_EVENT_UNAVAILABLE'
            );
            await expect(client.once(unknown, () => undefined)).rejects.toThrow(
                'WINDOW_EVENT_UNAVAILABLE'
            );
            expect(getTauriInvokeCalls()).toEqual([]);
        }
    );

    it('user given a failed native publication when publishing a model change then observes the original failure', async () => {
        interceptTauriInvoke((call, next) => {
            if (call.cmd === 'plugin:event|emit') throw new Error('native unavailable');
            return next();
        });
        await expect(
            settingsEvents.emit(AppEvent.AI_MODELS_UPDATED, { updatedAt: 1 })
        ).rejects.toThrow('native unavailable');
    });
});
