import { buildModelMessages } from '@touchai/models';
import type {
    AiContentPart,
    ModelDiagnostic,
    ModelsHost,
    ProviderDriver,
    RemoteRefRecord,
} from '@touchai/models/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

type Media = Extract<AiContentPart, { type: 'image' | 'file' }>;
type Context = NonNullable<Parameters<typeof buildModelMessages>[0]['attachmentContext']>;

const pdf = (overrides: Partial<Extract<Media, { type: 'file' }>> = {}): Media => ({
    type: 'file',
    kind: 'pdf',
    name: 'report.pdf',
    size: 8,
    mimeType: 'application/pdf',
    base64Data: 'JVBERi0=',
    resourceKey: 'opaque-document',
    fallbackText: 'Host-rendered document fallback',
    ...overrides,
});
const image = (overrides: Partial<Extract<Media, { type: 'image' }>> = {}): Media => ({
    type: 'image',
    kind: 'image',
    name: 'chart.png',
    size: 2 * 1024 * 1024,
    mimeType: 'image/png',
    data: 'iVBORw0KGgo=',
    resourceKey: 'opaque-image',
    ...overrides,
});

function fixture(driver: ProviderDriver = 'openai') {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const cache = new Map<string, RemoteRefRecord>();
    const touched: string[] = [];
    const diagnostics: ModelDiagnostic[] = [];
    const host: ModelsHost = {
        fetch,
        remoteRefs: {
            read: async (key) => cache.get(key) ?? null,
            touch: async (key) => {
                touched.push(key);
            },
            write: async (key, value) => {
                cache.set(key, value);
            },
        },
        diagnostics: (event) => {
            diagnostics.push(event);
        },
    };
    const base =
        driver === 'google'
            ? 'https://generativelanguage.example.test/v1beta'
            : 'https://api.example.test/v1';
    const context: Context = {
        driver,
        modelId: 'fixture-model',
        signal: new AbortController().signal,
        apiKey: 'fixture-key',
        customHeaders: {},
        fetch,
        host,
        apiTargets: {
            normalizedBaseUrl: base,
            sdkBaseUrl: base,
            generationTarget: base,
            discoveryTarget: base,
        },
        uploadState: { disabled: false, loggedDisabled: false, loggedFallback: false },
    };
    return {
        fetch,
        cache,
        touched,
        diagnostics,
        host,
        encode: (part: Media = pdf()) =>
            buildModelMessages({
                providerDriver: driver,
                modelId: 'fixture-model',
                messages: [{ role: 'user', content: [part] }],
                attachmentContext: context,
            }),
    };
}

function uploadStart(url: string | null = 'https://upload.example.test/session'): Response {
    return new Response(null, { headers: url ? { 'x-goog-upload-url': url } : {} });
}
const googleFile = (file: Record<string, unknown>) => Response.json({ file });
const remote = (value: Awaited<ReturnType<ReturnType<typeof fixture>['encode']>>) =>
    value.transport[0]?.transportMode === 'provider-file-ref';

afterEach(() => vi.useRealTimers());

describe('given a connection-bound cache and the actual message transport policy', () => {
    it('user uploads a document once and the next message reuses its saved reference', async () => {
        const input = fixture();
        input.fetch.mockResolvedValueOnce(Response.json({ id: 'file-abc' }));
        expect(remote(await input.encode())).toBe(true);
        expect(input.cache.get('opaque-document')).toEqual({
            ref: 'file-abc',
            expiresAt: null,
            mimeType: 'application/pdf',
        });
        expect(JSON.stringify((await input.encode()).messages)).toContain('file-abc');
        expect(input.fetch).toHaveBeenCalledTimes(1);
        expect(input.touched).toEqual(['opaque-document']);
    });

    it.each([null, 'sometime later'])(
        'user keeps a cached reference with an absent or unreadable expiry %s',
        async (expiresAt) => {
            const input = fixture();
            input.cache.set('opaque-document', { ref: 'file-reused', expiresAt });
            expect(JSON.stringify((await input.encode()).messages)).toContain('file-reused');
            expect(input.fetch).not.toHaveBeenCalled();
            expect(input.touched).toEqual(['opaque-document']);
        }
    );

    it('user uploads again when the cached reference has expired', async () => {
        const input = fixture();
        input.cache.set('opaque-document', {
            ref: 'file-stale',
            expiresAt: new Date(Date.now() - 60_000).toISOString(),
        });
        input.fetch.mockResolvedValueOnce(Response.json({ id: 'file-fresh' }));
        expect(JSON.stringify((await input.encode()).messages)).toContain('file-fresh');
        expect(input.touched).toEqual([]);
    });

    it('user keeps a valid reference when refreshing its last-use timestamp fails', async () => {
        const input = fixture();
        input.cache.set('opaque-document', { ref: 'file-kept', expiresAt: null });
        input.host.remoteRefs.touch = async () => {
            throw new Error('storage busy');
        };
        expect(JSON.stringify((await input.encode()).messages)).toContain('file-kept');
        expect(input.fetch).not.toHaveBeenCalled();
        expect(input.diagnostics).toEqual([{ kind: 'remote-ref-touch-failed', driver: 'openai' }]);
    });

    it.each([400, 401, 403, 404, 405, 415, 422, 501])(
        'user falls back inline and avoids repeated uploads after permanent refusal %i',
        async (status) => {
            const input = fixture();
            input.fetch.mockResolvedValueOnce(new Response(null, { status }));
            for (let attempt = 0; attempt < 2; attempt++)
                expect(remote(await input.encode())).toBe(false);
            expect(input.fetch).toHaveBeenCalledTimes(1);
            expect(input.cache.size).toBe(0);
        }
    );

    it.each([new Error('socket hang up'), undefined, 'temporary network loss'])(
        'user retries an upload on the next message after a transient failure %s',
        async (error) => {
            const input = fixture();
            input.fetch
                .mockRejectedValueOnce(error)
                .mockResolvedValueOnce(Response.json({ id: 'file-retried' }));
            expect(remote(await input.encode())).toBe(false);
            expect(JSON.stringify((await input.encode()).messages)).toContain('file-retried');
            expect(input.cache.get('opaque-document')?.ref).toBe('file-retried');
        }
    );

    it('user avoids repeat uploads when a string rejection reports permanent authorization refusal', async () => {
        const input = fixture();
        input.fetch.mockRejectedValueOnce('Unauthorized');
        expect(remote(await input.encode())).toBe(false);
        expect(remote(await input.encode())).toBe(false);
        expect(input.fetch).toHaveBeenCalledTimes(1);
    });

    it('user sends a document inline when a driver has no file-storage protocol', async () => {
        const input = fixture('anthropic');
        expect((await input.encode()).transport[0]?.transportMode).toBe('inline-base64');
        expect(input.fetch).not.toHaveBeenCalled();
    });

    it('user keeps images inline for a driver whose stored file ids cannot represent images', async () => {
        const input = fixture();
        expect((await input.encode(image())).transport[0]?.transportMode).toBe('inline-image');
        expect(input.fetch).not.toHaveBeenCalled();
    });

    it('user sends an uncached resource inline without inventing a Desktop storage identity', async () => {
        const input = fixture();
        expect(remote(await input.encode(pdf({ resourceKey: undefined })))).toBe(false);
        expect(input.fetch).not.toHaveBeenCalled();
        expect(input.cache.size).toBe(0);
    });

    it('user gets the host fallback when a document has no uploadable payload', async () => {
        const input = fixture();
        const result = await input.encode(pdf({ base64Data: undefined }));
        expect(JSON.stringify(result.messages)).toContain('Host-rendered document fallback');
        expect(remote(result)).toBe(false);
        expect(input.fetch).not.toHaveBeenCalled();
    });

    it('user sends text as text without an unnecessary provider upload', async () => {
        const input = fixture();
        const result = await input.encode(
            pdf({
                kind: 'text',
                name: 'notes.txt',
                mimeType: 'text/plain',
                base64Data: undefined,
                textContent: 'hello world',
            })
        );
        expect(result.messages).toEqual([
            { role: 'user', content: [{ type: 'text', text: 'hello world' }] },
        ]);
        expect(input.fetch).not.toHaveBeenCalled();
    });

    it('user falls back inline when the upload succeeds without returning a file id', async () => {
        const input = fixture();
        input.fetch.mockResolvedValueOnce(Response.json({}));
        expect(remote(await input.encode())).toBe(false);
        expect(input.cache.size).toBe(0);
    });
});

describe('given Google resumable upload and bounded processing', () => {
    it('user gets a processed remote URL and expiry from the actual upload protocol', async () => {
        const input = fixture('google');
        input.fetch.mockResolvedValueOnce(uploadStart()).mockResolvedValueOnce(
            googleFile({
                name: 'files/abc',
                uri: 'https://files.example.test/abc',
                state: 'ACTIVE',
                expirationTime: '2099-07-01T00:00:00.000Z',
            })
        );
        expect(JSON.stringify((await input.encode(image())).messages)).toContain(
            'https://files.example.test/abc'
        );
        expect(input.cache.get('opaque-image')).toMatchObject({
            ref: 'https://files.example.test/abc',
            expiresAt: '2099-07-01T00:00:00.000Z',
        });
        expect(input.fetch.mock.calls[0]?.[0]).toBe(
            'https://generativelanguage.example.test/upload/v1beta/files'
        );
    });

    it('user waits for processing and receives the URL only when the uploaded file becomes active', async () => {
        vi.useFakeTimers();
        const input = fixture('google');
        input.fetch
            .mockResolvedValueOnce(uploadStart())
            .mockResolvedValueOnce(googleFile({ name: 'files/pending', state: 'PROCESSING' }))
            .mockResolvedValueOnce(
                googleFile({
                    name: 'files/pending',
                    uri: 'https://files.example.test/ready',
                    state: 'ACTIVE',
                })
            );
        const encoded = input.encode(image());
        await vi.advanceTimersByTimeAsync(500);
        expect(JSON.stringify((await encoded).messages)).toContain(
            'https://files.example.test/ready'
        );
        expect(input.cache.get('opaque-image')?.expiresAt).toBeNull();
    });

    it.each([
        { label: 'missing file name', payload: { uri: 'https://files.example.test/orphan' } },
        { label: 'failed processing', payload: { name: 'files/bad', state: 'FAILED' } },
    ])(
        'user sends inline after $label without caching an unusable reference',
        async ({ payload }) => {
            const input = fixture('google');
            input.fetch
                .mockResolvedValueOnce(uploadStart())
                .mockResolvedValueOnce(googleFile(payload));
            expect((await input.encode(image())).transport[0]?.transportMode).toBe('inline-image');
            expect(input.cache.size).toBe(0);
        }
    );

    it('user sends inline when upload initialization omits the resumable session URL', async () => {
        const input = fixture('google');
        input.fetch.mockResolvedValueOnce(uploadStart(null));
        expect(remote(await input.encode(image()))).toBe(false);
        expect(input.cache.size).toBe(0);
    });

    it('user sends inline when the provider rejects upload finalization', async () => {
        const input = fixture('google');
        input.fetch
            .mockResolvedValueOnce(uploadStart())
            .mockResolvedValueOnce(new Response(null, { status: 500 }));
        expect(remote(await input.encode(image()))).toBe(false);
        expect(input.cache.size).toBe(0);
    });

    it.each([Response.json('not-a-file-record'), new Response(null, { status: 503 })])(
        'user sends inline when a processing lookup cannot supply a usable file',
        async (reply) => {
            vi.useFakeTimers();
            const input = fixture('google');
            input.fetch
                .mockResolvedValueOnce(uploadStart())
                .mockResolvedValueOnce(googleFile({ name: 'files/pending', state: 'PROCESSING' }));
            input.fetch.mockImplementation(async () => reply.clone());
            const encoded = input.encode(image());
            await vi.advanceTimersByTimeAsync(11_000);
            expect(remote(await encoded)).toBe(false);
            expect(input.cache.size).toBe(0);
        }
    );

    it('user stops retrying a Google upload endpoint that permanently refuses uploads', async () => {
        const input = fixture('google');
        input.fetch.mockResolvedValueOnce(new Response(null, { status: 501 }));
        expect(remote(await input.encode(image()))).toBe(false);
        expect(remote(await input.encode(image()))).toBe(false);
        expect(input.fetch).toHaveBeenCalledTimes(1);
    });

    it('user gets an inline fallback after the bounded processing budget expires', async () => {
        vi.useFakeTimers();
        const input = fixture('google');
        input.fetch
            .mockResolvedValueOnce(uploadStart())
            .mockImplementation(async () =>
                googleFile({ name: 'files/stuck', state: 'PROCESSING' })
            );
        const encoded = input.encode(image());
        await vi.advanceTimersByTimeAsync(11_000);
        expect(remote(await encoded)).toBe(false);
        expect(input.cache.size).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });
});
