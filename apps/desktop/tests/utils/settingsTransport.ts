// In-memory settings transport for tests: one bus, many simulated windows. It models the
// Tauri event boundary so owner/client ordering, focus, drops and owner restart are
// deterministic in a single process.
import {
    assertDeliverableSend,
    type SettingsTransport,
} from '@/services/SettingsService/transport';
import type { SettingsWireMessage } from '@/services/SettingsService/wire';

export interface SettingsSentRecord {
    from: string;
    target: string;
    message: SettingsWireMessage;
}

export interface SettingsBus {
    transport(label: string): SettingsTransport;
    focus(label: string): void;
    sent: SettingsSentRecord[];
    dropNotices: boolean;
    dropRequests: boolean;
    dropReplies: boolean;
    pauseDelivery: boolean;
    failNotices: boolean;
}

export function createSettingsBus(): SettingsBus {
    const listeners = new Map<string, Set<(message: SettingsWireMessage) => void>>();
    const focusListeners = new Map<string, Set<() => void>>();

    const bus: SettingsBus = {
        sent: [],
        dropNotices: false,
        dropRequests: false,
        dropReplies: false,
        pauseDelivery: false,
        failNotices: false,
        transport(label) {
            return {
                label,
                async send(target, message) {
                    assertDeliverableSend(target, message);
                    bus.sent.push({ from: label, target, message });
                    if (bus.failNotices && message.kind === 'notice') {
                        throw new Error('settings notice delivery failed');
                    }
                    if (bus.pauseDelivery) {
                        return;
                    }
                    if (bus.dropNotices && message.kind === 'notice') {
                        return;
                    }
                    if (
                        bus.dropRequests &&
                        (message.kind === 'snapshot-request' || message.kind === 'mutate-request')
                    ) {
                        return;
                    }
                    if (bus.dropReplies && message.kind === 'reply') {
                        return;
                    }
                    if (target === '*') {
                        for (const handlers of listeners.values()) {
                            for (const handler of [...handlers]) {
                                handler(message);
                            }
                        }
                        return;
                    }
                    const handlers = listeners.get(target);
                    if (handlers) {
                        for (const handler of [...handlers]) {
                            handler(message);
                        }
                    }
                },
                async listen(handler) {
                    const handlers = listeners.get(label) ?? new Set();
                    handlers.add(handler);
                    listeners.set(label, handlers);
                    return () => {
                        handlers.delete(handler);
                    };
                },
                async onFocus(handler) {
                    const handlers = focusListeners.get(label) ?? new Set();
                    handlers.add(handler);
                    focusListeners.set(label, handlers);
                    return () => {
                        handlers.delete(handler);
                    };
                },
            };
        },
        focus(label) {
            for (const handler of [...(focusListeners.get(label) ?? [])]) {
                handler();
            }
        },
    };

    return bus;
}
