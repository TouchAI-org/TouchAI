// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import {
    flushObservability,
    initObservability,
    log,
    resetObservabilityForTests,
} from '@services/ObservabilityService';
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

describe('user gets service logs as structured events', () => {
    it('user sees a trailing object kept as structured fields', async () => {
        initObservability();

        log.warn('connection failed', { code: 'mcp.connect_failed', retries: 2 });
        await flushObservability();

        const [entry] = sentEntries();
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

        const [entry] = sentEntries();
        expect(entry?.msg).toContain('tool failed');
        expect(entry?.msg).toContain('boom');
    });

    it('user does not see raw secrets in a logged message', async () => {
        initObservability();

        log.info('GET https://example.test/v1?token=secret-value');
        await flushObservability();

        const [entry] = sentEntries();
        expect(entry?.msg).not.toContain('secret-value');
    });
});

describe('user gets third-party console failures as structured events', () => {
    it('user sees a console warning mirrored without disabling the native output', async () => {
        const nativeWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        initObservability();

        console.warn('third-party warning');
        await flushObservability();

        expect(nativeWarn).toHaveBeenCalledWith('third-party warning');
        expect(sentEntries()[0]).toMatchObject({
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
        expect(sentEntries()).toEqual([]);
    });
});
