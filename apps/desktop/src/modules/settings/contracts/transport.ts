// Copyright (c) 2026. 千诚. Licensed under GPL v3

import {
    isDeliverableSettingsTarget,
    SETTINGS_BROADCAST_TARGET,
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
    listen(handler: (message: SettingsWireMessage) => void): Promise<() => void>;
    onFocus(handler: () => void): Promise<() => void>;
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
