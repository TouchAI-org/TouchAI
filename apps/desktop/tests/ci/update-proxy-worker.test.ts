import { afterEach, describe, expect, it, vi } from 'vitest';

type UpdateProxyWorkerModule = {
    default: {
        fetch: (
            request: Request,
            env: Record<string, unknown>,
            context: { waitUntil: (promise: Promise<unknown>) => void }
        ) => Promise<Response>;
    };
    deriveReleaseTagFromAssetName: (fileName: string) => string | null;
};

type BucketObject = {
    body: ReadableStream<Uint8Array> | null;
    httpEtag?: string;
    range?: {
        length?: number;
        offset?: number;
        suffix?: number;
    };
    size?: number;
    writeHttpMetadata?: (headers: Headers) => void;
};

class MemoryCache {
    readonly match = vi.fn(async (request: Request) => {
        return this.entries.get(request.url)?.clone();
    });

    readonly put = vi.fn(async (request: Request, response: Response) => {
        this.entries.set(request.url, response.clone());
    });

    private readonly entries = new Map<string, Response>();
}

async function loadWorker(): Promise<UpdateProxyWorkerModule | undefined> {
    try {
        return (await import('../../scripts/cloudflare/update-proxy-worker.mjs')) as UpdateProxyWorkerModule;
    } catch {
        return undefined;
    }
}

function installCache(cache: MemoryCache) {
    vi.stubGlobal('caches', { default: cache });
}

function workerContext() {
    const pending: Promise<unknown>[] = [];
    return {
        context: {
            waitUntil: (promise: Promise<unknown>) => {
                pending.push(promise);
            },
        },
        async flush() {
            await Promise.all(pending);
        },
    };
}

function r2Object(
    body: string,
    headers: Record<string, string> = {},
    options: { range?: BucketObject['range']; size?: number } = {}
): BucketObject {
    const response = new Response(body);
    return {
        body: response.body,
        httpEtag: '"r2-etag"',
        range: options.range,
        size: options.size ?? body.length,
        writeHttpMetadata(metadata) {
            for (const [key, value] of Object.entries(headers)) {
                metadata.set(key, value);
            }
        },
    };
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('update proxy Worker', () => {
    it('serves update assets from R2 before using the GitHub fallback', async () => {
        const worker = await loadWorker();
        const cache = new MemoryCache();
        installCache(cache);
        const fetchMock = vi.fn<typeof fetch>();
        vi.stubGlobal('fetch', fetchMock);

        const env = {
            UPDATE_BASE_PATH: 'touchai-app/v1',
            GITHUB_REPOSITORY: 'TouchAI-org/TouchAI',
            UPDATE_BUCKET: {
                get: vi.fn(async () =>
                    r2Object('from-r2', { 'content-type': 'application/octet-stream' })
                ),
            },
        };
        const request = new Request(
            'https://updates.touch-ai.org/touchai-app/v1/TouchAI-beta-0.1.1-beta.14-windows.msi'
        );
        const { context } = workerContext();

        expect(worker?.default.fetch).toBeTypeOf('function');
        const response = await worker!.default.fetch(request, env, context);

        expect(response.status).toBe(200);
        expect(await response.text()).toBe('from-r2');
        expect(response.headers.get('etag')).toBe('"r2-etag"');
        expect(env.UPDATE_BUCKET.get).toHaveBeenCalledWith(
            'touchai-app/v1/TouchAI-beta-0.1.1-beta.14-windows.msi',
            {
                range: request.headers,
            }
        );
        expect(fetchMock).not.toHaveBeenCalled();
        expect(cache.put).not.toHaveBeenCalled();
    });

    it('proxies cacheable R2 misses from the matching GitHub Release asset', async () => {
        const worker = await loadWorker();
        const cache = new MemoryCache();
        installCache(cache);
        const fetchMock = vi.fn<typeof fetch>(async () => {
            return new Response('from-github', {
                status: 200,
                headers: { 'content-type': 'application/octet-stream' },
            });
        });
        vi.stubGlobal('fetch', fetchMock);

        const env = {
            UPDATE_BASE_PATH: 'touchai-app/v1',
            GITHUB_REPOSITORY: 'TouchAI-org/TouchAI',
            UPDATE_BUCKET: {
                get: vi.fn(async () => null),
            },
        };
        const request = new Request(
            'https://updates.touch-ai.org/touchai-app/v1/TouchAI-beta-0.1.1-beta.14-windows-full.nupkg'
        );
        const { context, flush } = workerContext();

        expect(worker?.default.fetch).toBeTypeOf('function');
        const response = await worker!.default.fetch(request, env, context);
        await flush();

        expect(response.status).toBe(200);
        expect(await response.text()).toBe('from-github');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0]?.[0]).toBe(
            'https://github.com/TouchAI-org/TouchAI/releases/download/v0.1.1-beta.14/TouchAI-beta-0.1.1-beta.14-windows-full.nupkg'
        );
        expect(cache.put).toHaveBeenCalledTimes(1);

        const cached = await worker!.default.fetch(request, env, workerContext().context);
        expect(await cached.text()).toBe('from-github');
        expect(fetchMock).toHaveBeenCalledTimes(1);

        const headResponse = await worker!.default.fetch(
            new Request(request.url, { method: 'HEAD' }),
            env,
            workerContext().context
        );
        expect(headResponse.status).toBe(200);
        expect(await headResponse.text()).toBe('');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('sets range metadata for partial R2 responses', async () => {
        const worker = await loadWorker();
        const fetchMock = vi.fn<typeof fetch>();
        vi.stubGlobal('fetch', fetchMock);

        const env = {
            UPDATE_BASE_PATH: 'touchai-app/v1',
            GITHUB_REPOSITORY: 'TouchAI-org/TouchAI',
            UPDATE_BUCKET: {
                get: vi.fn(async () =>
                    r2Object('2345', {}, { range: { offset: 2, length: 4 }, size: 10 })
                ),
            },
        };
        const request = new Request(
            'https://updates.touch-ai.org/touchai-app/v1/TouchAI-0.2.0-windows.msi',
            {
                headers: { range: 'bytes=2-5' },
            }
        );

        expect(worker?.default.fetch).toBeTypeOf('function');
        const response = await worker!.default.fetch(request, env, workerContext().context);

        expect(response.status).toBe(206);
        expect(response.headers.get('content-range')).toBe('bytes 2-5/10');
        expect(response.headers.get('content-length')).toBe('4');
        expect(await response.text()).toBe('2345');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns a controlled error when R2 access fails', async () => {
        const worker = await loadWorker();
        const fetchMock = vi.fn<typeof fetch>();
        vi.stubGlobal('fetch', fetchMock);
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

        const env = {
            UPDATE_BASE_PATH: 'touchai-app/v1',
            GITHUB_REPOSITORY: 'TouchAI-org/TouchAI',
            UPDATE_BUCKET: {
                get: vi.fn(async () => {
                    throw new Error('r2 unavailable');
                }),
            },
        };
        const request = new Request(
            'https://updates.touch-ai.org/touchai-app/v1/TouchAI-0.2.0-windows.msi'
        );

        expect(worker?.default.fetch).toBeTypeOf('function');
        const response = await worker!.default.fetch(request, env, workerContext().context);

        expect(response.status).toBe(503);
        expect(await response.text()).toBe('Update storage failed: r2 unavailable');
        expect(consoleError).toHaveBeenCalledWith(
            'Update R2 lookup failed',
            expect.objectContaining({
                error: 'r2 unavailable',
                key: 'touchai-app/v1/TouchAI-0.2.0-windows.msi',
                method: 'GET',
            })
        );
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('forwards range requests to GitHub but does not cache partial responses', async () => {
        const worker = await loadWorker();
        const cache = new MemoryCache();
        installCache(cache);
        const fetchMock = vi.fn<typeof fetch>(async () => {
            return new Response('partial', {
                status: 206,
                headers: {
                    'content-range': 'bytes 0-6/20',
                    'content-type': 'application/octet-stream',
                },
            });
        });
        vi.stubGlobal('fetch', fetchMock);

        const env = {
            UPDATE_BASE_PATH: 'touchai-app/v1',
            GITHUB_REPOSITORY: 'TouchAI-org/TouchAI',
            UPDATE_BUCKET: {
                get: vi.fn(async () => null),
            },
        };
        const request = new Request(
            'https://updates.touch-ai.org/touchai-app/v1/TouchAI-0.2.0-windows.msi',
            {
                headers: { range: 'bytes=0-6' },
            }
        );

        expect(worker?.default.fetch).toBeTypeOf('function');
        const response = await worker!.default.fetch(request, env, workerContext().context);

        expect(response.status).toBe(206);
        expect(response.headers.get('content-range')).toBe('bytes 0-6/20');
        const firstFetchInit = fetchMock.mock.calls[0]?.[1];
        expect(firstFetchInit).toMatchObject({
            method: 'GET',
            headers: expect.any(Headers),
        });
        expect((firstFetchInit?.headers as Headers).get('range')).toBe('bytes=0-6');
        expect(cache.put).not.toHaveBeenCalled();
    });

    it('returns a controlled error when the GitHub fallback request fails', async () => {
        const worker = await loadWorker();
        const cache = new MemoryCache();
        installCache(cache);
        const fetchMock = vi.fn<typeof fetch>(async () => {
            throw new TypeError('network unavailable');
        });
        vi.stubGlobal('fetch', fetchMock);

        const env = {
            UPDATE_BASE_PATH: 'touchai-app/v1',
            GITHUB_REPOSITORY: 'TouchAI-org/TouchAI',
            UPDATE_BUCKET: {
                get: vi.fn(async () => null),
            },
        };
        const request = new Request(
            'https://updates.touch-ai.org/touchai-app/v1/TouchAI-0.2.0-windows.msi'
        );

        expect(worker?.default.fetch).toBeTypeOf('function');
        const response = await worker!.default.fetch(request, env, workerContext().context);

        expect(response.status).toBe(502);
        expect(await response.text()).toBe('GitHub fallback failed: network unavailable');
        expect(cache.put).not.toHaveBeenCalled();
    });

    it('rejects invalid asset names instead of becoming an open proxy', async () => {
        const worker = await loadWorker();
        const cache = new MemoryCache();
        installCache(cache);
        const fetchMock = vi.fn<typeof fetch>();
        vi.stubGlobal('fetch', fetchMock);
        const env = {
            UPDATE_BASE_PATH: 'touchai-app/v1',
            GITHUB_REPOSITORY: 'TouchAI-org/TouchAI',
            UPDATE_BUCKET: {
                get: vi.fn(async () => null),
            },
        };

        expect(worker?.deriveReleaseTagFromAssetName).toBeTypeOf('function');
        expect(worker?.deriveReleaseTagFromAssetName('TouchAI-beta-latest-windows.msi')).toBeNull();

        const response = await worker!.default.fetch(
            new Request(
                'https://updates.touch-ai.org/touchai-app/v1/TouchAI-beta-latest-windows.msi'
            ),
            env,
            workerContext().context
        );

        expect(response.status).toBe(404);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
