// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { emit, emitTo, listen as listenEvent, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

import {
    isDeliverableSettingsTarget,
    parseSettingsWireMessage,
    SETTINGS_BROADCAST_TARGET,
    SETTINGS_TRANSPORT_EVENT,
    type SettingsWireMessage,
} from './wire';

export { SETTINGS_BROADCAST_TARGET } from './wire';

/**
 * Boundary between the settings engine and the host windowing layer. The default
 * implementation wraps Tauri events: directed requests/replies use a window-targeted emit
 * (so a reply carrying a snapshot, which can include secrets, reaches only its window),
 * while only value-free notices broadcast. Tests provide an in-memory bus with the same
 * contract so cross-window ordering, focus, drops and owner restart are deterministic.
 */
export interface SettingsTransport {
    readonly label: string;
    send(target: string, message: SettingsWireMessage): Promise<void>;
    listen(handler: (message: SettingsWireMessage) => void): Promise<UnlistenFn>;
    onFocus(handler: () => void): Promise<UnlistenFn>;
}

/**
 * Reject a send that would either broadcast a value-bearing message or address a
 * non-concrete window. Kept as a shared helper so the in-memory test bus enforces the
 * exact same boundary as the real Tauri transport.
 */
export function assertDeliverableSend(target: string, message: SettingsWireMessage): void {
    if (target === SETTINGS_BROADCAST_TARGET) {
        if (message.kind !== 'notice') {
            throw new Error(
                `Settings transport refuses to broadcast a ${message.kind}: only value-free notices may be broadcast.`
            );
        }
        return;
    }
    if (!isDeliverableSettingsTarget(target)) {
        throw new Error(`Settings transport refuses to send to an invalid target "${target}".`);
    }
}

function currentWindowLabel(): string {
    try {
        return getCurrentWindow().label;
    } catch {
        return 'unknown';
    }
}

export function createTauriSettingsTransport(label = currentWindowLabel()): SettingsTransport {
    return {
        label,
        async send(target, message) {
            assertDeliverableSend(target, message);
            if (target === SETTINGS_BROADCAST_TARGET) {
                await emit(SETTINGS_TRANSPORT_EVENT, message);
                return;
            }
            await emitTo(target, SETTINGS_TRANSPORT_EVENT, message);
        },
        async listen(handler) {
            return await listenEvent<unknown>(SETTINGS_TRANSPORT_EVENT, (event) => {
                const message = parseSettingsWireMessage(event.payload);
                if (message) {
                    handler(message);
                }
            });
        },
        async onFocus(handler) {
            try {
                return await getCurrentWindow().onFocusChanged(({ payload }) => {
                    if (payload) {
                        handler();
                    }
                });
            } catch {
                return () => undefined;
            }
        },
    };
}
