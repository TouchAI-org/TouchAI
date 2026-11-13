import { beforeEach, describe, expect, it, vi } from 'vitest';

import { executeWebSearchTool } from '@/services/BuiltInToolService/tools/webSearch';

/**
 * A provider rejection is turned into a retryable `WebSearchHttpError` without
 * reading the body. With the pull-driven wrapper that error response has to be
 * cancelled explicitly, or the native reader stays open. The real
 * `createTauriFetch` runs against a controlled upstream stream.
 */
const { readEffectiveSettingValueMock, pluginFetch } = vi.hoisted(() => ({
    readEffectiveSettingValueMock: vi.fn<() => Promise<string | null>>(async () => null),
    pluginFetch: vi.fn(),
}));

vi.mock('@/services/BuiltInToolService/settingsReader', () => ({
    readEffectiveSettingValue: readEffectiveSettingValueMock,
}));

vi.mock('@tauri-apps/plugin-http', () => ({ fetch: pluginFetch }));

const DISCARD_REASON = 'WebSearch response discarded';

interface ControlledStream {
    stream: ReadableStream<Uint8Array>;
    cancelReasons: unknown[];
}

function controlledStream(chunkCount = 4): ControlledStream {
    let index = 0;
    const cancelReasons: unknown[] = [];
    const chunks = Array.from({ length: chunkCount }, (_, i) =>
        new TextEncoder().encode(`chunk-${i}`)
    );
    const stream = new ReadableStream<Uint8Array>(
        {
            pull(controller) {
                const chunk = chunks[index];
                if (chunk === undefined) {
                    controller.close();
                    return;
                }
                controller.enqueue(chunk);
                index += 1;
            },
            cancel(reason) {
                cancelReasons.push(reason);
            },
        },
        new CountQueuingStrategy({ highWaterMark: 1 })
    );
    return { stream, cancelReasons };
}

function createExecutionContext(): Parameters<typeof executeWebSearchTool>[2] {
    return {
        signal: new AbortController().signal,
        callId: 'web-search-call',
        iteration: 1,
    };
}

describe('user searches the web and the provider rejects the request', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        readEffectiveSettingValueMock.mockResolvedValue(null);
    });

    it('user gets the provider error and the unread error body is released', async () => {
        const source = controlledStream();
        pluginFetch.mockResolvedValueOnce(
            new Response(source.stream, {
                status: 500,
                statusText: 'Internal Server Error',
                headers: { 'content-type': 'application/json' },
            })
        );

        const result = await executeWebSearchTool(
            { query: 'agentic web research', intent: 'academic', maxResults: 3 },
            {},
            createExecutionContext()
        );

        expect(result.isError).toBe(true);
        expect(result.errorMessage).toBe('HTTP 500 Internal Server Error');
        expect(source.cancelReasons).toEqual([DISCARD_REASON]);
    });
});
