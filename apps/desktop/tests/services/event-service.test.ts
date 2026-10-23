import { AppEvent, eventService } from '@services/EventService';
import type {
    SearchSurfaceShownEvent,
    SettingsGeneralUpdatedEvent,
} from '@services/EventService/types';
import { emit } from '@tauri-apps/api/event';
import { getLastTauriInvokeCall, interceptTauriInvoke } from '@tests/utils/tauri';
import { describe, expect, it, vi } from 'vitest';

describe('user receives app events across windows', () => {
    it('user sees an app event delivered through the native event channel', async () => {
        const payload: SettingsGeneralUpdatedEvent = {
            sourceId: 'settings-view',
            windowLabel: 'main',
            key: 'global_shortcut',
            value: 'Ctrl+Shift+K',
        };

        await eventService.emit(AppEvent.SETTINGS_GENERAL_UPDATED, payload);

        expect(getLastTauriInvokeCall('plugin:event|emit')).toEqual({
            cmd: 'plugin:event|emit',
            payload: {
                event: AppEvent.SETTINGS_GENERAL_UPDATED,
                payload,
            },
        });
    });

    it('user stops receiving an event after they unsubscribe', async () => {
        const callback = vi.fn();
        const payload: SearchSurfaceShownEvent = {
            source: 'shortcut',
            sequence: 2,
        };

        const unlisten = await eventService.on(AppEvent.SEARCH_SURFACE_SHOWN, callback);
        await emit(AppEvent.SEARCH_SURFACE_SHOWN, payload);

        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith(payload);

        await unlisten();
        await emit(AppEvent.SEARCH_SURFACE_SHOWN, { source: 'shortcut', sequence: 3 });

        expect(callback).toHaveBeenCalledTimes(1);
    });

    it('user receives a one-shot event exactly once', async () => {
        const callback = vi.fn();

        await eventService.once(AppEvent.FONT_READY, callback);
        await emit(AppEvent.FONT_READY, {});
        await emit(AppEvent.FONT_READY, {});

        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith({});
    });

    it('user sees an event emit failure instead of a silent drop', async () => {
        const backendError = new Error('emit failed');
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        interceptTauriInvoke((call, next) => {
            if (call.cmd === 'plugin:event|emit') {
                throw backendError;
            }

            return next();
        });

        await expect(eventService.emit(AppEvent.FONT_READY, {})).rejects.toThrow(backendError);
        expect(consoleErrorSpy).toHaveBeenCalled();
    });

    it('user sees a subscription failure instead of a silent no-op', async () => {
        const backendError = new Error('listen failed');
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        interceptTauriInvoke((call, next) => {
            if (call.cmd === 'plugin:event|listen') {
                throw backendError;
            }

            return next();
        });

        await expect(
            eventService.on(AppEvent.SEARCH_SURFACE_HIDDEN, () => undefined)
        ).rejects.toThrow(backendError);
        expect(consoleErrorSpy).toHaveBeenCalled();
    });
});
