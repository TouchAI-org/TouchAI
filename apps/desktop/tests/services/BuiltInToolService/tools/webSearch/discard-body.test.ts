import { createWebSearchToolsFixture, saveWebSearchSettings } from '@tests/utils/webSearchTools';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const { execute: executeWebSearchTool } = createWebSearchToolsFixture();

/**
 * A provider rejection is turned into a retryable `WebSearchHttpError` without
 * reading the body. With the pull-driven wrapper that error response has to be
 * cancelled explicitly, or the native reader stays open. The real
 * `createTauriFetch` runs against a controlled upstream stream.
 */
const { pluginFetch } = vi.hoisted(() => ({
    pluginFetch: vi.fn(),
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
        saveWebSearchSettings(null);
    });

    it('user gets the provider error and the unread error body is released', async () => {
        const sources: ControlledStream[] = [];
        pluginFetch.mockImplementation(() => {
            const source = controlledStream();
            sources.push(source);
            return Promise.resolve(
                new Response(source.stream, {
                    status: 500,
                    statusText: 'Internal Server Error',
                    headers: { 'content-type': 'application/json' },
                })
            );
        });

        const result = await executeWebSearchTool(
            { query: 'agentic web research', intent: 'academic', maxResults: 3 },
            {},
            createExecutionContext()
        );

        expect(result.isError).toBe(true);
        expect(result.errorMessage).toBe('HTTP 500 Internal Server Error');
        expect(sources.length).toBeGreaterThan(0);
        expect(sources[0]!.cancelReasons).toEqual([DISCARD_REASON]);
    });
});
