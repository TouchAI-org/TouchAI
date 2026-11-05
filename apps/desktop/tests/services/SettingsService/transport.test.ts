import { beforeEach, describe, expect, it, vi } from 'vitest';

const tauri = vi.hoisted(() => ({
    emit: vi.fn(async () => undefined),
    emitTo: vi.fn(async () => undefined),
    listeners: new Set<(event: { payload: unknown }) => void>(),
}));

vi.mock('@tauri-apps/api/event', () => ({
    emit: tauri.emit,
    emitTo: tauri.emitTo,
    listen: vi.fn(async (_name: string, handler: (event: { payload: unknown }) => void) => {
        tauri.listeners.add(handler);
        return () => {
            tauri.listeners.delete(handler);
        };
    }),
}));

vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => ({
        label: 'win-a',
        onFocusChanged: vi.fn(async () => () => undefined),
    }),
}));

import { createDefaultGeneralSettings } from '@/services/SettingsService/domain';
import {
    createTauriSettingsTransport,
    SETTINGS_BROADCAST_TARGET,
} from '@/services/SettingsService/transport';
import { SETTINGS_TRANSPORT_EVENT } from '@/services/SettingsService/wire';

function deliver(payload: unknown) {
    for (const listener of [...tauri.listeners]) {
        listener({ payload });
    }
}

describe('user cannot leak settings through the settings transport', () => {
    beforeEach(() => {
        tauri.emit.mockClear();
        tauri.emitTo.mockClear();
        tauri.listeners.clear();
    });

    it('user keeps a value-free notice as the only broadcastable message', async () => {
        const transport = createTauriSettingsTransport('main');

        await transport.send(SETTINGS_BROADCAST_TARGET, {
            kind: 'notice',
            hostEpoch: 'epoch-1',
            revision: 1,
            type: 'change',
            changedKeys: ['language'],
        });

        expect(tauri.emit).toHaveBeenCalledTimes(1);
        expect(tauri.emit).toHaveBeenCalledWith(
            SETTINGS_TRANSPORT_EVENT,
            expect.objectContaining({ kind: 'notice' })
        );
        expect(tauri.emitTo).not.toHaveBeenCalled();
    });

    it('user never broadcasts a reply or a request that could carry a snapshot', async () => {
        const transport = createTauriSettingsTransport('main');

        await expect(
            transport.send(SETTINGS_BROADCAST_TARGET, {
                kind: 'reply',
                requestId: 'req-1',
                hostEpoch: 'epoch-1',
                ok: true,
                snapshot: {
                    hostEpoch: 'epoch-1',
                    revision: 1,
                    ready: true,
                    data: createDefaultGeneralSettings(),
                },
            })
        ).rejects.toThrow(/broadcast/i);

        await expect(
            transport.send(SETTINGS_BROADCAST_TARGET, {
                kind: 'snapshot-request',
                requestId: 'req-2',
                from: 'win-b',
                hostEpoch: null,
            })
        ).rejects.toThrow(/broadcast/i);

        expect(tauri.emit).not.toHaveBeenCalled();
        expect(tauri.emitTo).not.toHaveBeenCalled();
    });

    it('user never sends to an empty or broadcast target', async () => {
        const transport = createTauriSettingsTransport('main');

        await expect(
            transport.send('', {
                kind: 'notice',
                hostEpoch: 'epoch-1',
                revision: 1,
                type: 'change',
                changedKeys: [],
            })
        ).rejects.toThrow(/invalid target/i);

        expect(tauri.emitTo).not.toHaveBeenCalled();
    });

    it('user replies to the requesting window with a directed, non-broadcast send', async () => {
        const transport = createTauriSettingsTransport('main');

        const reply = {
            kind: 'reply' as const,
            requestId: 'req-1',
            hostEpoch: 'epoch-1',
            ok: false as const,
            code: 'settings-not-ready',
            message: 'not ready',
        };
        await transport.send('win-b', reply);

        expect(tauri.emitTo).toHaveBeenCalledTimes(1);
        expect(tauri.emitTo).toHaveBeenCalledWith('win-b', SETTINGS_TRANSPORT_EVENT, reply);
        expect(tauri.emit).not.toHaveBeenCalled();
    });

    it('user drops malformed envelopes before they reach a handler', async () => {
        const transport = createTauriSettingsTransport('win-a');
        const received: unknown[] = [];
        await transport.listen((message) => received.push(message));

        const malformed = [
            // Unknown kind.
            { kind: 'gimme', requestId: 'r', from: 'win-b', hostEpoch: null },
            // A broadcast window must never be an accepted sender.
            { kind: 'snapshot-request', requestId: 'r', from: '*', hostEpoch: null },
            {
                kind: 'mutate-request',
                requestId: 'r',
                from: '',
                hostEpoch: null,
                key: 'a',
                value: 1,
            },
            // Negative / non-finite revision.
            { kind: 'notice', hostEpoch: 'e', revision: -1, type: 'change', changedKeys: [] },
            { kind: 'notice', hostEpoch: '', revision: 1, type: 'change', changedKeys: [] },
            // Mutation without a value.
            { kind: 'mutate-request', requestId: 'r', from: 'win-b', hostEpoch: null, key: 'a' },
            // Reply with both payloads / a failed reply without a code.
            {
                kind: 'reply',
                requestId: 'r',
                hostEpoch: 'e',
                ok: true,
                snapshot: { hostEpoch: 'e', revision: 1, ready: true, data: {} },
                result: { status: 'restored', key: 'a', code: 'x', message: 'm' },
            },
            { kind: 'reply', requestId: 'r', hostEpoch: 'e', ok: false },
            // Extra unexpected field.
            { kind: 'notice', hostEpoch: 'e', revision: 1, type: 'change', changedKeys: [], x: 1 },
        ];
        for (const payload of malformed) {
            deliver(payload);
        }

        expect(received).toHaveLength(0);
    });

    it('user receives well-formed envelopes after validation', async () => {
        const transport = createTauriSettingsTransport('win-a');
        const received: unknown[] = [];
        await transport.listen((message) => received.push(message));

        deliver({
            kind: 'notice',
            hostEpoch: 'epoch-1',
            revision: 3,
            type: 'change',
            changedKeys: ['language'],
        });
        deliver({
            kind: 'snapshot-request',
            requestId: 'req-9',
            from: 'win-b',
            hostEpoch: null,
        });

        expect(received).toHaveLength(2);
        expect(received[0]).toMatchObject({ kind: 'notice', revision: 3 });
        expect(received[1]).toMatchObject({ kind: 'snapshot-request', requestId: 'req-9' });
    });
});
