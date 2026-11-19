// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { getTauriInvokeCalls } from '@tests/utils/tauri';
import { afterEach, describe, expect, it } from 'vitest';

import {
    flushObservability,
    initObservability,
    resetObservabilityForTests,
} from '@/platform/diagnostics';
import { installEarlyErrors } from '@/platform/diagnostics/early-errors';

afterEach(() => {
    resetObservabilityForTests();
});

describe('user sees errors that happen before the app mounts', () => {
    it('user gets an early rejection replayed after observability starts', async () => {
        installEarlyErrors();
        window.dispatchEvent(
            new PromiseRejectionEvent('unhandledrejection', {
                promise: Promise.resolve(),
                reason: new Error('startup failed'),
            })
        );

        initObservability();
        await flushObservability();

        const entries = getTauriInvokeCalls('obs_ingest').flatMap(
            (call) => (call.payload as { batch: Array<Record<string, unknown>> }).batch
        );
        expect(entries).toContainEqual(
            expect.objectContaining({
                event: 'app.unhandled-rejection',
                msg: expect.stringContaining('startup failed'),
            })
        );
    });
});
