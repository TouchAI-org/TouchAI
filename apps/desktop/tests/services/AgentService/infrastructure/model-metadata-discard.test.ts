import { updateModelMetadata } from '@services/AgentService/infrastructure/modelMetadata';
import { interceptTauriInvoke } from '@tests/utils/tauri';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The metadata refresh throws on a non-2xx source without reading the body. With
 * the pull-driven wrapper that response has to be cancelled explicitly. The real
 * `createTauriFetch` runs against a controlled upstream stream; the database is
 * reached only to read the stored ETag and answers empty here.
 */
const { pluginFetch } = vi.hoisted(() => ({ pluginFetch: vi.fn() }));

vi.mock('@tauri-apps/plugin-http', () => ({ fetch: pluginFetch }));

const DISCARD_REASON = 'ModelMetadata response discarded';

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

describe('user refreshes model metadata and the source rejects the request', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        interceptTauriInvoke((call) => {
            if (call.cmd === 'database_operation') {
                return null;
            }
            return undefined;
        });
    });

    it('user gets the metadata refresh failure and the unread error body is released', async () => {
        const source = controlledStream();
        pluginFetch.mockResolvedValueOnce(
            new Response(source.stream, {
                status: 500,
                statusText: 'Internal Server Error',
            })
        );

        await expect(updateModelMetadata()).rejects.toThrow(
            'Failed to fetch metadata: Internal Server Error'
        );
        expect(source.cancelReasons).toEqual([DISCARD_REASON]);
    });
});
