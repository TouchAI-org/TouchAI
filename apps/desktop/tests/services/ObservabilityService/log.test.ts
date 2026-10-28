// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import {
    event,
    flushObservability,
    initObservability,
    log,
    resetObservabilityForTests,
} from '@services/ObservabilityService';
import { reportLoggingFailure } from '@services/ObservabilityService/console';
import { getTauriInvokeCalls } from '@tests/utils/tauri';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
    resetObservabilityForTests();
});

function sentEntries() {
    return getTauriInvokeCalls('obs_ingest').flatMap(
        (call) => (call.payload as { batch: Array<Record<string, unknown>> }).batch
    );
}

function sentEvent(event: string) {
    return sentEntries().find((entry) => entry.event === event);
}

function lastEntry() {
    const entries = sentEntries();
    return entries[entries.length - 1];
}

describe('user gets service logs as structured events', () => {
    it('user sees a trailing object kept as structured fields', async () => {
        initObservability();

        log.warn('connection failed', { code: 'mcp.connect_failed', retries: 2 });
        await flushObservability();

        const entry = sentEvent('app.log');
        expect(entry).toMatchObject({
            level: 4,
            event: 'app.log',
            msg: 'connection failed',
            attrs: { code: 'mcp.connect_failed', retries: 2 },
        });
    });

    it('user sees console style arguments joined into one message', async () => {
        initObservability();

        log.error('tool failed', new Error('boom'));
        await flushObservability();

        const entry = sentEvent('app.log');
        expect(entry?.msg).toContain('tool failed');
        expect(entry?.msg).toContain('boom');
    });

    it('user does not see raw secrets in a logged message', async () => {
        initObservability();

        log.info('GET https://example.test/v1?token=secret-value');
        await flushObservability();

        const entry = sentEvent('app.log');
        expect(entry?.msg).not.toContain('secret-value');
    });

    it('user does not get a multi-line provider error body written to the log', async () => {
        initObservability();

        log.error(
            'request failed',
            new Error('400 Bad Request\n{"prompt":"private conversation text"}')
        );
        await flushObservability();

        const entry = sentEvent('app.log');
        expect(entry?.msg).toContain('400 Bad Request');
        expect(entry?.msg).not.toContain('private conversation text');
    });

    it('user gets an event with no message when nothing was logged', async () => {
        initObservability();

        log.trace();
        await flushObservability();

        const entry = lastEntry();
        expect(entry).toMatchObject({ level: 1, event: 'app.log' });
        expect(entry?.msg).toBeUndefined();
    });

    it('user gets a value that cannot be serialised kept as text', async () => {
        initObservability();
        const circular: Record<string, unknown> = {};
        circular.self = circular;

        log.warn(circular, 'state');
        await flushObservability();

        expect(lastEntry()?.msg).toContain('[object Object]');
    });

    it('user still gets the result when a typed event does not match its schema', async () => {
        initObservability();

        expect(() => event('agent.request.failed', {} as never)).not.toThrow();
        await flushObservability();

        expect(sentEvent('obs.schema.invalid')).toMatchObject({
            level: 5,
            attrs: { 'obs.event': 'agent.request.failed' },
        });
    });
});

describe('user gets third-party console failures as structured events', () => {
    it('user sees a console warning mirrored without disabling the native output', async () => {
        const nativeWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        initObservability();

        console.warn('third-party warning');
        await flushObservability();

        expect(nativeWarn).toHaveBeenCalledWith('third-party warning');
        expect(sentEvent('external.console')).toMatchObject({
            level: 4,
            event: 'external.console',
            attrs: {
                'external.level': 'warn',
                'external.argument_count': 1,
            },
            msg: 'third-party warning',
        });
    });

    it('user does not see third-party debug output in the release log', async () => {
        const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
        initObservability();

        console.debug('third-party debug');
        await flushObservability();

        expect(debug).toHaveBeenCalledWith('third-party debug');
        expect(sentEvent('external.console')).toBeUndefined();
    });

    it('user gets a third-party value that cannot be serialised kept as text', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        initObservability();
        const circular: Record<string, unknown> = {};
        circular.self = circular;

        console.warn(circular, undefined);
        await flushObservability();

        const entry = lastEntry();
        expect(entry?.msg).toContain('[object Object]');
        expect(entry?.msg).toContain('undefined');
    });

    it('user gets a third-party error without a stack described by its message', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        initObservability();
        const error = new Error('connection dropped');
        error.stack = undefined;

        console.error(error);
        await flushObservability();

        expect(lastEntry()?.msg).toContain('Error: connection dropped');
    });
});

describe('user keeps a logging failure visible on the native console', () => {
    it('user sees the original console error when a log batch cannot be sent', () => {
        const nativeError = vi.spyOn(console, 'error').mockImplementation(() => {});
        initObservability();

        reportLoggingFailure(new Error('ipc closed'));

        expect(nativeError).toHaveBeenCalledWith(
            '[Observability] failed to send log batch',
            expect.any(Error)
        );
    });
});
