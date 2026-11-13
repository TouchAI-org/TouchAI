import { AppEvent, eventService } from '@services/EventService';
import { flushPromises } from '@vue/test-utils';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useMcpStore } from '@/stores/mcp';

import {
    getTauriInvokeCalls,
    interceptTauriInvoke,
    mockTauriCommand,
    type TauriInvokeCall,
} from '../utils/tauri';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((complete) => {
        resolve = complete;
    });
    return { promise, resolve };
}

function isStatusRegistration(call: TauriInvokeCall): boolean {
    return (
        call.cmd === 'plugin:event|listen' &&
        (call.payload as { event?: string })?.event === AppEvent.MCP_STATUS
    );
}

async function broadcastStatus() {
    await eventService.emit(AppEvent.MCP_STATUS, { serverId: 7, status: 'connected' });
    await flushPromises();
}

let pinia: ReturnType<typeof createPinia>;

beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    mockTauriCommand('database_operation', (payload: unknown) => {
        const { request } = payload as { request?: { kind?: string } };
        if (request?.kind === 'mcp_server_list') return [];
        return null;
    });
    mockTauriCommand('mcp_get_all_client_statuses', () => []);
});

afterEach(async () => {
    disposePinia(pinia);
    await flushPromises();
});

describe('user initializes and leaves the MCP status view', () => {
    it('user initializes concurrently and receives one status subscription', async () => {
        const store = useMcpStore();

        await Promise.all([store.initialize(), store.initialize()]);
        await broadcastStatus();

        expect(store.initialized).toBe(true);
        expect(store.getServerStatus(7)).toBe('connected');
        expect(getTauriInvokeCalls().filter(isStatusRegistration)).toHaveLength(1);
    });

    it('user disposes the store scope and queued status events no longer mutate it', async () => {
        const store = useMcpStore();
        await store.initialize();

        store.$dispose();
        await broadcastStatus();

        expect(store.initialized).toBe(false);
        expect(store.getServerStatus(7)).toBe('disconnected');
        expect(getTauriInvokeCalls('plugin:event|unlisten')).toEqual([
            expect.objectContaining({
                payload: expect.objectContaining({ event: AppEvent.MCP_STATUS }),
            }),
        ]);
    });

    it('user disposes during storage loading and no native registration starts later', async () => {
        const started = deferred();
        const read = deferred();
        interceptTauriInvoke(async (call, next) => {
            if (call.cmd === 'database_operation') {
                started.resolve();
                await read.promise;
            }
            return next();
        });
        const store = useMcpStore();
        const initialization = store.initialize();
        await started.promise;

        store.$dispose();
        read.resolve();
        await initialization;

        expect(store.initialized).toBe(false);
        expect(getTauriInvokeCalls().filter(isStatusRegistration)).toEqual([]);
    });

    it('user disposes during registration and the late listener is released without refreshing', async () => {
        const started = deferred();
        const registration = deferred();
        interceptTauriInvoke(async (call, next) => {
            if (isStatusRegistration(call)) {
                const result = await next();
                started.resolve();
                await registration.promise;
                return result;
            }
            return next();
        });
        const store = useMcpStore();
        const initialization = store.initialize();
        await started.promise;

        store.$dispose();
        await broadcastStatus();
        registration.resolve();
        await initialization;

        expect(store.initialized).toBe(false);
        expect(store.getServerStatus(7)).toBe('disconnected');
        expect(getTauriInvokeCalls('mcp_get_all_client_statuses')).toEqual([]);
        expect(getTauriInvokeCalls('plugin:event|unlisten')).toHaveLength(1);
    });

    it('user retries failed status registration and receives live status updates', async () => {
        let fail = true;
        interceptTauriInvoke(async (call, next) => {
            if (isStatusRegistration(call) && fail) {
                fail = false;
                throw new Error('registration unavailable');
            }
            return next();
        });
        const store = useMcpStore();

        await expect(store.initialize()).rejects.toThrow('registration unavailable');
        expect(store.initialized).toBe(false);
        await store.initialize();
        await broadcastStatus();

        expect(store.initialized).toBe(true);
        expect(store.getServerStatus(7)).toBe('connected');
    });
});
