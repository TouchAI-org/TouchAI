import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    configureE2eModel,
    requestModelAdministration,
} from '../../../apps/desktop/e2e-tests/test/support/model-administration.js';
import {
    modelDraftSchema,
    modelPatchSchema,
    providerDraftSchema,
    providerPatchSchema,
} from '../../../apps/desktop/src/modules/models/administration';

const desktop = vi.hoisted(() => ({
    callE2eBridge: vi.fn(),
    closeSettingsWindow: vi.fn(),
    switchToWindowContaining: vi.fn(),
    switchToWindowWithE2eBridge: vi.fn(),
    waitForTestIdDisplayed: vi.fn(),
}));
vi.mock('../../../apps/desktop/e2e-tests/test/support/desktop.js', () => desktop);

let callbacks;
let listeners;
let commands;
let respond;

beforeEach(() => {
    vi.clearAllMocks();
    desktop.switchToWindowContaining.mockResolvedValue('settings-handle');
    callbacks = new Map();
    listeners = new Set();
    commands = [];
    respond = (payload, callback) =>
        callback({
            payload: { requestId: payload.requestId, ok: true, result: { id: 17 } },
        });
    let nextId = 0;
    vi.stubGlobal('window', {
        __TAURI_INTERNALS__: {
            metadata: { currentWindow: { label: 'settings' } },
            transformCallback(callback) {
                const id = ++nextId;
                callbacks.set(id, callback);
                return id;
            },
            unregisterCallback(id) {
                callbacks.delete(id);
            },
            async invoke(command, data) {
                if (command === 'plugin:event|listen') {
                    listeners.add(data.handler);
                    return data.handler;
                }
                if (command === 'plugin:event|unlisten') {
                    listeners.delete(data.eventId);
                    return;
                }
                if (command !== 'plugin:event|emit_to') throw new Error('Unexpected IPC');
                expect(data.target).toEqual({ kind: 'AnyLabel', label: 'main' });
                expect(data.event).toBe('models:administration:request');
                expect(data.payload.from).toBe('settings');
                commands.push(data.payload.command);
                respond(data.payload, callbacks.get([...listeners][0]));
            },
        },
        __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} },
    });
    vi.stubGlobal('browser', {
        execute: (fn, command) => fn(command),
        getWindowHandle: async () => 'main-handle',
        switchToWindow: vi.fn(),
        closeWindow: vi.fn(),
    });
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('user configures an E2E model through the existing Settings owner', () => {
    it('user given a confirmed command when the owner replies then receives the result and releases listeners', async () => {
        await expect(
            requestModelAdministration({ operation: 'model-create', data: { name: 'Fixture' } })
        ).resolves.toEqual({ id: 17 });
        expect(commands).toEqual([{ operation: 'model-create', data: { name: 'Fixture' } }]);
        expect(callbacks.size).toBe(0);
        expect(listeners.size).toBe(0);
    });

    it('user given an unrelated reply when awaiting confirmation then receives only the matching request result', async () => {
        respond = (payload, callback) => {
            callback({ payload: { requestId: 'unrelated', ok: true, result: 'wrong' } });
            callback({ payload: { requestId: payload.requestId, ok: true, result: 'confirmed' } });
        };
        await expect(requestModelAdministration({ operation: 'models' })).resolves.toBe(
            'confirmed'
        );
    });

    it('user given an owner rejection when configuring a model then sees failure and no replay is sent', async () => {
        respond = (payload, callback) =>
            callback({
                payload: {
                    requestId: payload.requestId,
                    ok: false,
                    code: 'MODEL_ADMINISTRATION_FAILED',
                    outcome: 'unknown',
                },
            });
        await expect(
            requestModelAdministration({ operation: 'set-default', id: 17 })
        ).rejects.toThrow('MODEL_ADMINISTRATION_FAILED (unknown)');
        expect(commands).toHaveLength(1);
        expect(callbacks.size).toBe(0);
        expect(listeners.size).toBe(0);
    });

    it('user given no confirmation when the command times out then sees uncertainty and releases resources without retry', async () => {
        vi.useFakeTimers();
        respond = () => {};
        const pending = requestModelAdministration({ operation: 'set-default', id: 17 });
        const failure = expect(pending).rejects.toThrow('did not confirm');
        await vi.advanceTimersByTimeAsync(10_000);
        await failure;
        expect(commands).toHaveLength(1);
        expect(callbacks.size).toBe(0);
        expect(listeners.size).toBe(0);
    });

    it('user given a main-window context when configuring a model then cannot bypass Settings ownership', async () => {
        window.__TAURI_INTERNALS__.metadata.currentWindow.label = 'main';
        await expect(requestModelAdministration({ operation: 'models' })).rejects.toThrow(
            'must originate in Settings'
        );
        expect(commands).toEqual([]);
        expect(callbacks.size).toBe(0);
    });
});

describe('user prepares repeated native queue scenarios with the existing model profile', () => {
    it.each([false, true])(
        'user given existing profile=%s when configuring the fixture then the Settings owner accepts the commands and refreshes main',
        async (existing) => {
            respond = ({ requestId, command }, callback) => {
                let result;
                switch (command.operation) {
                    case 'models':
                        result = existing
                            ? [
                                  {
                                      id: 17,
                                      provider_id: 9,
                                      provider_name: 'TouchAI E2E Local',
                                      model_id: 'queue-fixture',
                                  },
                              ]
                            : [];
                        break;
                    case 'provider-create':
                        providerDraftSchema.parse(command.data);
                        result = { id: 9 };
                        break;
                    case 'provider-update':
                        providerPatchSchema.parse(command.patch);
                        break;
                    case 'model-create':
                        modelDraftSchema.parse(command.data);
                        result = { id: 17 };
                        break;
                    case 'model-update':
                        modelPatchSchema.parse(command.patch);
                        break;
                    case 'set-default':
                        expect(command.id).toBe(17);
                        break;
                    default:
                        throw new Error('Unexpected model administration command');
                }
                callback({ payload: { requestId, ok: true, result } });
            };
            await configureE2eModel('http://127.0.0.1:43001/v1', 'queue-fixture', 'Queue fixture');
            expect(commands.map((command) => command.operation)).toEqual([
                'models',
                existing ? 'provider-update' : 'provider-create',
                existing ? 'model-update' : 'model-create',
                'set-default',
            ]);
            expect(desktop.callE2eBridge.mock.calls.map(([method]) => method)).toEqual([
                'openSettingsWindow',
                'refreshE2eModel',
            ]);
            expect(desktop.switchToWindowWithE2eBridge).toHaveBeenCalledWith('main-handle');
            expect(callbacks.size).toBe(0);
            expect(listeners.size).toBe(0);
        }
    );
});
