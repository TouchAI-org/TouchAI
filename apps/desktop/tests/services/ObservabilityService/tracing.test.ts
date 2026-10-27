// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { native } from '@services/NativeService';
import { initObservability, resetObservabilityForTests } from '@services/ObservabilityService';
import { currentTraceparent, isValidTraceparent } from '@services/ObservabilityService/traceparent';
import { resetTracingForTests, withSpan } from '@services/ObservabilityService/tracing';
import { getLastTauriInvokeCall } from '@tests/utils/tauri';
import { afterEach, describe, expect, it } from 'vitest';

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
