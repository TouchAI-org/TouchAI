// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { getTauriInvokeCalls } from '@tests/utils/tauri';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalConsole = {
    trace: console.trace,
    debug: console.debug,
    info: console.info,
    warn: console.warn,
    error: console.error,
    log: console.log,
};

function restoreConsole() {
    console.trace = originalConsole.trace;
    console.debug = originalConsole.debug;
    console.info = originalConsole.info;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
    console.log = originalConsole.log;
}

async function initializeFreshLogger() {
    vi.resetModules();
    const { initializeLogger } = await import('@services/LoggerService');
    initializeLogger();
    return initializeLogger;
}

async function flushLogs() {
    const { flushObservability } = await import('@services/ObservabilityService');
    await flushObservability();
}

function logEntries() {
    return getTauriInvokeCalls('obs_ingest').flatMap(
        (call) => (call.payload as { batch: Array<Record<string, unknown>> }).batch
    );
}

beforeEach(() => {
    vi.resetModules();
});

afterEach(async () => {
    const { resetObservabilityForTests } = await import('@services/ObservabilityService');
    resetObservabilityForTests();
    restoreConsole();
});

describe('user reads app logs in the log file', () => {
    it('user sees a console log line written to the app log file', async () => {
        await initializeFreshLogger();

        console.log('workspace ready');
        await flushLogs();

        expect(logEntries()).toEqual([
            expect.objectContaining({
                level: 3,
                event: 'legacy.console',
                msg: 'workspace ready',
            }),
        ]);
    });

    it('user sees each console level kept as its own log level', async () => {
        await initializeFreshLogger();

        console.debug('debug line');
        console.info('info line');
        console.warn('warn line');
        console.error('error line');
        await flushLogs();

        expect(logEntries().map((entry) => entry.level)).toEqual([2, 3, 4, 5]);
    });

    it('user sees structured values and errors readable in the log file', async () => {
        await initializeFreshLogger();

        console.warn('request failed', { statusCode: 500 }, new Error('boom'));
        await flushLogs();

        const [entry] = logEntries() as Array<{ msg: string }>;
        expect(entry?.msg).toContain('request failed');
        expect(entry?.msg).toContain('{"statusCode":500}');
        expect(entry?.msg).toContain('boom');
    });

    it('user sees a log line recorded once even when startup initializes logging twice', async () => {
        const initializeLogger = await initializeFreshLogger();

        initializeLogger();
        console.info('single line');
        await flushLogs();

        expect(logEntries()).toHaveLength(1);
    });

    it('user keeps logging locally when the log backend rejects the entry', async () => {
        const { interceptTauriInvoke } = await import('@tests/utils/tauri');
        await initializeFreshLogger();
        interceptTauriInvoke((call, next) => {
            if (call.cmd === 'obs_ingest') {
                return Promise.reject(new Error('log backend down'));
            }

            return next();
        });
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

        expect(() => console.error('still visible locally')).not.toThrow();
        await flushLogs();

        expect(consoleError).toHaveBeenCalled();
    });
});
