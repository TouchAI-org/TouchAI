import { emit } from '@tauri-apps/api/event';
import { getTauriInvokeCalls, mockTauriCommand } from '@tests/utils/tauri';
import { flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initObservability, log, resetObservabilityForTests } from '@/platform/diagnostics';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((complete) => {
        resolve = complete;
    });
    return { promise, resolve };
}
beforeEach(() => resetObservabilityForTests());
afterEach(() => {
    resetObservabilityForTests();
    vi.useRealTimers();
});
async function startLogging(message: string) {
    initObservability();
    log.info(message);
    await flushPromises();
}

describe('given a window with queued diagnostic logs', () => {
    it('user closes the window and queued logs finish before the approved native close', async () => {
        const write = deferred();
        mockTauriCommand('obs_ingest', () => write.promise);
        await startLogging('last line before close');

        await emit('tauri://close-requested');
        await flushPromises();
        expect(getTauriInvokeCalls('plugin:window|close')).toEqual([]);
        expect(getTauriInvokeCalls('obs_ingest')[0]?.payload).toMatchObject({
            batch: expect.arrayContaining([
                expect.objectContaining({ msg: 'last line before close' }),
            ]),
        });
        write.resolve();
        await vi.waitFor(() => expect(getTauriInvokeCalls('plugin:window|close')).toHaveLength(1));

        const commands = getTauriInvokeCalls().map(({ cmd }) => cmd);
        expect(commands.indexOf('plugin:event|unlisten')).toBeLessThan(
            commands.indexOf('plugin:window|close')
        );
        expect(getTauriInvokeCalls('plugin:window|destroy')).toEqual([]);
    });

    it('user closes the window when the log backend exceeds the bounded flush deadline', async () => {
        vi.useFakeTimers();
        mockTauriCommand('obs_ingest', () => new Promise<void>(() => {}));
        await startLogging('stuck line');
        await emit('tauri://close-requested');
        await vi.advanceTimersByTimeAsync(799);
        expect(getTauriInvokeCalls('plugin:window|close')).toEqual([]);

        await vi.advanceTimersByTimeAsync(1);
        await flushPromises();
        expect(getTauriInvokeCalls('plugin:window|close')).toHaveLength(1);
        expect(getTauriInvokeCalls('plugin:window|destroy')).toEqual([]);
    });

    it('user presses close twice during a flush and receives one log write and one close', async () => {
        const write = deferred();
        mockTauriCommand('obs_ingest', () => write.promise);
        await startLogging('double close');
        await emit('tauri://close-requested');
        await emit('tauri://close-requested');
        await flushPromises();
        write.resolve();
        await vi.waitFor(() => expect(getTauriInvokeCalls('plugin:window|close')).toHaveLength(1));

        expect(getTauriInvokeCalls('obs_ingest')).toHaveLength(1);
        expect(getTauriInvokeCalls('plugin:window|destroy')).toEqual([]);
    });

    it('user quits from the tray and native receives the window flush acknowledgement after its logs', async () => {
        const write = deferred();
        mockTauriCommand('obs_ingest', () => write.promise);
        await startLogging('last line before tray quit');
        await emit('obs://flush');
        await flushPromises();
        expect(getTauriInvokeCalls('obs_flush_done')).toEqual([]);
        write.resolve();
        await vi.waitFor(() => expect(getTauriInvokeCalls('obs_flush_done')).toHaveLength(1));

        expect(getTauriInvokeCalls('obs_ingest')).toHaveLength(1);
        expect(getTauriInvokeCalls('obs_flush_done')[0]?.payload).toEqual({ window: 'main' });
    });
});
