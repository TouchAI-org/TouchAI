// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { SpanStatusCode } from '@opentelemetry/api';
import { native } from '@services/NativeService';
import { invoke } from '@services/NativeService/invoke';
import { initObservability, resetObservabilityForTests } from '@services/ObservabilityService';
import { currentTraceparent, isValidTraceparent } from '@services/ObservabilityService/traceparent';
import { resetTracingForTests, withSpan } from '@services/ObservabilityService/tracing';
import { getLastTauriInvokeCall } from '@tests/utils/tauri';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
    resetObservabilityForTests();
    resetTracingForTests();
});

describe('user can follow one turn across retries and tools', () => {
    it('user gets the same trace id and distinct spans for turn, attempt and tool', async () => {
        const contexts: Array<{ traceId: string; spanId: string }> = [];

        await withSpan('touchai.turn', { 'gen_ai.conversation.id': 7 }, async (turn) => {
            contexts.push(turn.spanContext());
            await withSpan(
                'touchai.attempt',
                { 'touchai.attempt': 1 },
                async (attempt) => {
                    contexts.push(attempt.spanContext());
                    await withSpan(
                        'touchai.tool',
                        { 'gen_ai.tool.call.id': 'call-1' },
                        async (tool) => {
                            contexts.push(tool.spanContext());
                        },
                        attempt
                    );
                },
                turn
            );
        });

        expect(new Set(contexts.map((context) => context.traceId)).size).toBe(1);
        expect(new Set(contexts.map((context) => context.spanId)).size).toBe(3);
    });

    it('user gets a valid traceparent while a span is active', async () => {
        const traceparent = await withSpan('touchai.turn', {}, async () => {
            return currentTraceparent();
        });

        expect(traceparent).toBeDefined();
        expect(isValidTraceparent(traceparent!)).toBe(true);
    });
});

describe('user can correlate native work with the active turn', () => {
    it('user gets the active traceparent attached to an application invoke', async () => {
        initObservability();

        await withSpan('touchai.tool', { 'gen_ai.tool.name': 'bash' }, async () => {
            await native.paths.getAppDirectoryPath('LOGS');
        });

        const call = getLastTauriInvokeCall('get_app_directory_path');
        expect(call?.payload).toMatchObject({
            directory: 'LOGS',
        });
        expect(typeof (call?.payload as Record<string, unknown> | undefined)?.traceparent).toBe(
            'string'
        );
    });
});

describe('user keeps binary command payloads intact', () => {
    it('user gets the raw bytes passed through instead of a spread object', async () => {
        initObservability();
        const payload = new Uint8Array([1, 2, 3]);

        await withSpan('touchai.tool', { 'gen_ai.tool.name': 'file' }, async () => {
            await invoke('write_bytes', payload);
        });

        expect(getLastTauriInvokeCall('write_bytes')?.payload).toBe(payload);
    });
});

describe('user sees a failed attempt marked as an error in the trace', () => {
    it('user gets the error status when the attempt returns a failure', async () => {
        let status: { code: SpanStatusCode; message?: string } | undefined;

        await withSpan(
            'touchai.attempt',
            {},
            async (span) => {
                vi.spyOn(span, 'setStatus').mockImplementation((value) => {
                    status = value;
                    return span;
                });
                return { type: 'failed' as const, error: { code: 'provider.rate_limited' } };
            },
            undefined,
            (result) =>
                result.type === 'failed'
                    ? { code: SpanStatusCode.ERROR, message: result.error.code }
                    : undefined
        );

        expect(status).toMatchObject({
            code: SpanStatusCode.ERROR,
            message: 'provider.rate_limited',
        });
    });
});
