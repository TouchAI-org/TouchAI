import { mockWindows } from '@tauri-apps/api/mocks';
import { flushPromises } from '@vue/test-utils';
import { vi } from 'vitest';

import { updatePreferencesApiKey, updatesApiKey } from '@/app/api/updates';
import type {
    AppUpdateChannel,
    AppUpdateCheckSource,
    AppUpdateState,
} from '@/app/api/updates/contracts';
import { createInitialAppUpdateState } from '@/app/api/updates/contracts';
import { createUpdatesWindow } from '@/app/bootstrap/updates';
import { emitWindowEvent, listenWindowEvent } from '@/platform/windows/events';

/** Native event peer for view tests: the real Settings client parses every reply/state. */
export async function createUpdateClientBoundary() {
    mockWindows('settings');
    let state: AppUpdateState = createState();
    let revision = 0;
    const ownerId = crypto.randomUUID();
    function createState(): AppUpdateState {
        return {
            ...createInitialAppUpdateState(),
            status: 'not_available',
            currentVersion: '0.1.0',
            lastCheckedAt: '2026-05-22T10:00:00.000Z',
        };
    }
    const initialize = vi.fn(async () => undefined);
    const checkNow = vi.fn<(_source: AppUpdateCheckSource) => Promise<boolean>>(async () => true);
    const setChannel = vi.fn<(_channel: AppUpdateChannel) => Promise<void>>(async () => undefined);
    const setAutoCheckEnabled = vi.fn<(_enabled: boolean) => Promise<void>>(async () => undefined);
    const download = vi.fn(async () => true);
    const install = vi.fn(async () => true);
    const snapshot = () => ({ ownerId, revision, state });
    const stop = await listenWindowEvent('main', 'updates:request', (payload) => {
        const request = payload as {
            requestId: string;
            command: {
                operation: string;
                source: AppUpdateCheckSource;
                channel: AppUpdateChannel;
                enabled: boolean;
            };
        };
        void (async () => {
            try {
                let result: unknown = true;
                const command = request.command;
                if (command.operation === 'snapshot') await initialize();
                else if (command.operation === 'check') result = await checkNow(command.source);
                else if (command.operation === 'download') result = await download();
                else if (command.operation === 'install') result = await install();
                else if (command.operation === 'channel') await setChannel(command.channel);
                else if (command.operation === 'auto-check')
                    await setAutoCheckEnabled(command.enabled);
                await emitWindowEvent('settings', 'updates:reply', {
                    requestId: request.requestId,
                    ok: true,
                    result: result !== false,
                    snapshot: snapshot(),
                });
            } catch {
                await emitWindowEvent('settings', 'updates:reply', {
                    requestId: request.requestId,
                    ok: false,
                    code: 'UPDATES_UNCONFIRMED',
                });
            }
        })();
    });
    const lifetime = new AbortController();
    const window = createUpdatesWindow({
        label: 'settings',
        signal: lifetime.signal,
        warn: () => undefined,
    });
    const client = {
        updates: window.api,
        updatePreferences: window.preferences,
        async dispose() {
            lifetime.abort();
            window.dispose();
        },
    };
    return {
        client,
        initialize,
        checkNow,
        download,
        install,
        setChannel,
        setAutoCheckEnabled,
        createState,
        get state() {
            return state;
        },
        set state(next: AppUpdateState) {
            state = next;
            revision++;
        },
        publishState(patch: Partial<AppUpdateState>) {
            state = { ...state, ...patch };
            revision++;
            return emitWindowEvent('settings', 'updates:state', snapshot());
        },
        async synchronize() {
            await flushPromises();
            await emitWindowEvent('settings', 'updates:state', snapshot());
        },
        viewOptions: {
            global: {
                provide: {
                    [updatesApiKey as symbol]: client.updates,
                    [updatePreferencesApiKey as symbol]: client.updatePreferences!,
                },
            },
        },
        async dispose() {
            stop();
            await client.dispose();
        },
    };
}
