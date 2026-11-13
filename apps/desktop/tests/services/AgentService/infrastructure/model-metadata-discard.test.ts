import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Keep the production module and the real pull-driven HTTP wrapper in this test. The
 * database boundary only answers reads; the assertions are about discarded response
 * bodies, not about a mocked cancellation helper.
 */
const { pluginFetch, db } = vi.hoisted(() => ({
    pluginFetch: vi.fn(),
    db: {
        readSourceEtag: vi.fn(async () => 'W/"cached"'),
        markChecked: vi.fn(async () => undefined),
        replaceMetadata: vi.fn(async () => undefined),
        readLastCheckedAt: vi.fn(async () => null),
    },
}));

vi.mock('@tauri-apps/plugin-http', () => ({ fetch: pluginFetch }));
vi.mock('@/services/AgentService/infrastructure/modelMetadata/store', () => ({
    markModelMetadataChecked: db.markChecked,
    readModelMetadataLastCheckedAt: db.readLastCheckedAt,
    readModelMetadataSourceEtag: db.readSourceEtag,
    replaceModelMetadata: db.replaceMetadata,
}));

const { updateModelMetadata } =
    await import('@/services/AgentService/infrastructure/modelMetadata');

const DISCARD_REASON = 'ModelMetadata response discarded';

interface ControlledStream {
    stream: ReadableStream<Uint8Array>;
    cancelReasons: unknown[];
}

function controlledStream(): ControlledStream {
    const cancelReasons: unknown[] = [];
    const stream = new ReadableStream<Uint8Array>({
        pull() {},
        cancel(reason) {
            cancelReasons.push(reason);
        },
    });
    return { stream, cancelReasons };
}

describe('user refreshes model metadata through the real HTTP wrapper', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        db.readSourceEtag.mockResolvedValue('W/"cached"');
        db.markChecked.mockResolvedValue(undefined);
        db.replaceMetadata.mockResolvedValue(undefined);
    });

    it('user keeps cached metadata on a 304 without exposing a body', async () => {
        pluginFetch.mockResolvedValueOnce(new Response(null, { status: 304 }));

        await expect(updateModelMetadata()).resolves.toEqual({ status: 'unchanged' });

        expect(db.markChecked).toHaveBeenCalledWith({
            checkedAt: expect.any(String),
            etag: 'W/"cached"',
        });
        expect(db.replaceMetadata).not.toHaveBeenCalled();
    });

    it('user gets the refresh failure and the unread error body is released', async () => {
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
        expect(db.replaceMetadata).not.toHaveBeenCalled();
    });
});
