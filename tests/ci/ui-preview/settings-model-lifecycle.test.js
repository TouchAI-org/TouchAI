import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureE2eModel } from '../../../apps/desktop/e2e-tests/test/support/model-administration.js';

let boundary;

beforeEach(() => {
    let current = 'main';
    let settings;
    let generation = 0;
    const callbacks = new Map();
    const listeners = new Set();
    const commands = [];
    const refreshed = [];
    boundary = { commands, refreshed, refuseCommand: false, refuseClose: false };
    const page = {
        __TAURI_INTERNALS__: {
            metadata: { currentWindow: { label: 'main' } },
            transformCallback(callback) {
                const id = callbacks.size + 1;
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
                expect(current).toBe(settings.handle);
                expect(data.target).toEqual({ kind: 'AnyLabel', label: 'main' });
                expect(data.payload.from).toBe('settings');
                const operation = data.payload.command;
                commands.push(operation);
                const reply = boundary.refuseCommand
                    ? { ok: false, code: 'FIXTURE_REFUSED', outcome: 'not-applied' }
                    : {
                          ok: true,
                          result:
                              operation.operation === 'models'
                                  ? [
                                        {
                                            id: 17,
                                            provider_id: 9,
                                            provider_name: 'TouchAI E2E Local',
                                            model_id: 'fixture-model',
                                        },
                                    ]
                                  : undefined,
                      };
                for (const handler of listeners) {
                    callbacks.get(handler)({
                        payload: { requestId: data.payload.requestId, ...reply },
                    });
                }
            },
        },
        __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} },
    };
    const bridge = {
        async openSettingsWindow() {
            // Native ownership survives WebDriver's close-target command on WebView2.
            settings ??= { handle: `settings-${++generation}`, attached: true };
        },
        async refreshE2eModel() {
            expect(current).toBe('main');
            refreshed.push(generation);
        },
    };
    Object.defineProperty(page, '__TOUCHAI_E2E__', {
        get: () => (current === 'main' ? bridge : undefined),
    });
    vi.stubGlobal('window', page);
    vi.stubGlobal('browser', {
        execute: (fn, ...args) => fn(...args),
        getWindowHandle: async () => current,
        getWindowHandles: async () => ['main', ...(settings?.attached ? [settings.handle] : [])],
        async switchToWindow(handle) {
            if (handle !== 'main' && (!settings?.attached || settings.handle !== handle)) {
                throw new Error('No such window');
            }
            current = handle;
            page.__TAURI_INTERNALS__.metadata.currentWindow.label =
                handle === 'main' ? 'main' : 'settings';
        },
        getUrl: async () =>
            current === 'main' ? 'http://tauri.localhost/' : 'http://tauri.localhost/#/settings',
        async waitUntil(condition, { timeoutMsg }) {
            if (!(await condition())) throw new Error(timeoutMsg);
        },
        async closeWindow() {
            settings.attached = false;
            current = 'main';
        },
    });
    vi.stubGlobal('$', (selector) => ({
        async waitForDisplayed() {
            expect(settings?.attached).toBe(true);
            expect(current).toBe(settings.handle);
        },
        async click() {
            expect(selector).toBe("[data-testid='settings-window-close']");
            if (!boundary.refuseClose) settings = undefined;
        },
    }));
});

afterEach(() => vi.unstubAllGlobals());

describe('given several native scenarios share one application and driver session', () => {
    it('user configures a model twice through Settings and returns to main with both native windows released', async () => {
        await configureE2eModel('http://127.0.0.1:43001/v1', 'fixture-model', 'First fixture');
        await configureE2eModel('http://127.0.0.1:43002/v1', 'fixture-model', 'Second fixture');
        expect(boundary.refreshed).toEqual([1, 2]);
        expect(
            boundary.commands
                .filter((command) => command.operation === 'provider-update')
                .map((command) => command.patch.api_endpoint)
        ).toEqual(['http://127.0.0.1:43001/v1', 'http://127.0.0.1:43002/v1']);
        expect(await globalThis.browser.getWindowHandle()).toBe('main');
        expect(await globalThis.browser.getWindowHandles()).toEqual(['main']);
    });

    it('user sees an owner rejection and can configure the next model without a stranded Settings window', async () => {
        boundary.refuseCommand = true;
        await expect(
            configureE2eModel('http://127.0.0.1:43001/v1', 'fixture-model', 'Fixture')
        ).rejects.toThrow('FIXTURE_REFUSED');
        boundary.refuseCommand = false;
        await configureE2eModel('http://127.0.0.1:43001/v1', 'fixture-model', 'Fixture');
        expect(boundary.refreshed).toEqual([2]);
        expect(await globalThis.browser.getWindowHandle()).toBe('main');
        expect(await globalThis.browser.getWindowHandles()).toEqual(['main']);
    });

    it('user receives a cleanup failure when the native window refuses to close and is returned to main', async () => {
        boundary.refuseClose = true;
        await expect(
            configureE2eModel('http://127.0.0.1:43001/v1', 'fixture-model', 'Fixture')
        ).rejects.toThrow('Settings window did not close');
        expect(boundary.refreshed).toEqual([]);
        expect(await globalThis.browser.getWindowHandle()).toBe('main');
    });
});
