import { AppEvent, eventService } from '@services/EventService';
import type {
    SearchSurfaceShownEvent,
    SettingsGeneralUpdatedEvent,
} from '@services/EventService/types';
import { emit } from '@tauri-apps/api/event';
import { describe, expect, it, vi } from 'vitest';

import { getLastTauriInvokeCall, interceptTauriInvoke } from '../../utils/tauri';

describe('EventService', () => {
    it('emits typed application events through the tauri event plugin', async () => {
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

    it('delivers listened payloads through the public callback and stops after unlisten', async () => {
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

    it('delivers one-shot listeners only once', async () => {
        const callback = vi.fn();

        await eventService.once(AppEvent.FONT_READY, callback);
        await emit(AppEvent.FONT_READY, {});
        await emit(AppEvent.FONT_READY, {});

        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith({});
    });

    it('rethrows emit failures after logging them', async () => {
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

    it('rethrows listener registration failures after logging them', async () => {
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
