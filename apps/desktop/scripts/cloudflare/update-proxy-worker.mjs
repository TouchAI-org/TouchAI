import { deriveReleaseTagFromAssetName } from '../update-release-assets.mjs';

const DEFAULT_ASSET_CACHE_SECONDS = 31_536_000;
const DEFAULT_FEED_CACHE_SECONDS = 60;

export { deriveReleaseTagFromAssetName };

function trimSlashes(value) {
    return String(value ?? '').replace(/^\/+|\/+$/g, '');
}

function cacheSeconds(value, fallback) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function textResponse(message, status, extraHeaders = {}) {
    return new Response(message, {
        status,
        headers: {
            'content-type': 'text/plain; charset=utf-8',
            ...extraHeaders,
        },
    });
}

function messageFromError(error) {
    if (error instanceof Error && error.message) {
        return error.message;
    }
    return String(error ?? 'Unknown error');
}

function responseHeadersWithDefaults(headers, defaults) {
    const next = new Headers(headers);
    for (const [key, value] of Object.entries(defaults)) {
        if (!next.has(key)) {
            next.set(key, value);
        }
    }
    next.delete('set-cookie');
    return next;
}

function objectKeyFromRequest(url, basePath) {
    const normalizedBasePath = trimSlashes(basePath);
    if (!normalizedBasePath) {
        return null;
    }

    let decodedPath;
    try {
        decodedPath = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    } catch {
        return null;
    }

    if (!decodedPath.startsWith(`${normalizedBasePath}/`)) {
        return null;
    }
    if (decodedPath.includes('..') || decodedPath.includes('\\')) {
        return null;
    }

    const fileName = decodedPath.slice(normalizedBasePath.length + 1);
    if (!fileName || fileName.includes('/')) {
        return null;
    }

    return {
        key: `${normalizedBasePath}/${fileName}`,
        fileName,
    };
}

function isFeedFile(fileName) {
    return /^releases\.[a-z0-9_-]+\.json$/i.test(fileName);
}

function githubReleaseAssetUrl(repository, tag, fileName) {
    const normalizedRepository = String(repository ?? '').replace(/^\/+|\/+$/g, '');
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalizedRepository)) {
        return null;
    }

    return `https://github.com/${normalizedRepository}/releases/download/${encodeURIComponent(
        tag
    )}/${encodeURIComponent(fileName)}`;
}

function cacheKeyFor(request) {
    return new Request(request.url, { method: 'GET' });
}

function canUseWorkerCache(request) {
    return (request.method === 'GET' || request.method === 'HEAD') && !request.headers.has('range');
}

function defaultCacheControl(fileName, env) {
    if (isFeedFile(fileName)) {
        return `public, max-age=${cacheSeconds(env.UPDATE_FEED_CACHE_SECONDS, DEFAULT_FEED_CACHE_SECONDS)}`;
    }

    return `public, max-age=${cacheSeconds(
        env.UPDATE_ASSET_CACHE_SECONDS,
        DEFAULT_ASSET_CACHE_SECONDS
    )}, immutable`;
}

function r2ObjectRange(object) {
    const range = object?.range;
    const size = object?.size;
    if (!range || typeof range !== 'object' || !Number.isFinite(size) || size < 0) {
        return null;
    }

    const offset = Number(range.offset);
    if (Number.isFinite(offset) && offset >= 0) {
        const start = Math.trunc(offset);
        const length = Number(range.length);
        const requestedLength =
            Number.isFinite(length) && length > 0 ? Math.trunc(length) : size - start;
        if (start >= size || requestedLength <= 0) {
            return null;
        }

        const end = Math.min(start + requestedLength - 1, size - 1);
        return {
            contentLength: end - start + 1,
            contentRange: `bytes ${start}-${end}/${size}`,
        };
    }

    const suffix = Number(range.suffix);
    if (Number.isFinite(suffix) && suffix > 0 && size > 0) {
        const end = size - 1;
        const start = Math.max(size - Math.trunc(suffix), 0);
        return {
            contentLength: end - start + 1,
            contentRange: `bytes ${start}-${end}/${size}`,
        };
    }

    return null;
}

async function responseFromR2Object(request, object, fileName, env) {
    if (!object) {
        return null;
    }

    const headers = new Headers();
    object.writeHttpMetadata?.(headers);
    headers.set('cache-control', defaultCacheControl(fileName, env));
    headers.set('accept-ranges', 'bytes');
    if (object.httpEtag) {
        headers.set('etag', object.httpEtag);
    }
    if (typeof object.size === 'number' && !headers.has('content-length')) {
        headers.set('content-length', String(object.size));
    }
    const range = r2ObjectRange(object);
    if (range) {
        headers.set('content-range', range.contentRange);
        headers.set('content-length', String(range.contentLength));
    }

    return new Response(request.method === 'HEAD' ? null : object.body, {
        status: object.range ? 206 : 200,
        headers,
    });
}

async function responseFromR2(request, env, key, fileName) {
    const bucket = env.UPDATE_BUCKET;
    if (!bucket?.get) {
        return null;
    }

    let object;
    try {
        object =
            request.method === 'HEAD' && bucket.head
                ? await bucket.head(key)
                : await bucket.get(key, { range: request.headers });
    } catch (error) {
        console.error('Update R2 lookup failed', {
            error: messageFromError(error),
            key,
            method: request.method,
        });
        return textResponse(`Update storage failed: ${messageFromError(error)}`, 503);
    }
    return responseFromR2Object(request, object, fileName, env);
}

function fallbackHeaders(request) {
    const headers = new Headers();
    const range = request.headers.get('range');
    if (range) {
        headers.set('range', range);
    }
    return headers;
}

async function responseFromGitHub(request, env, fileName) {
    const tag = deriveReleaseTagFromAssetName(fileName);
    if (!tag) {
        return null;
    }

    const url = githubReleaseAssetUrl(env.GITHUB_REPOSITORY, tag, fileName);
    if (!url) {
        return null;
    }

    let response;
    try {
        response = await fetch(url, {
            method: request.method,
            headers: fallbackHeaders(request),
            redirect: 'follow',
        });
    } catch (error) {
        return textResponse(`GitHub fallback failed: ${messageFromError(error)}`, 502);
    }
    if (response.status === 404) {
        return null;
    }
    if (!response.ok && response.status !== 206) {
        return textResponse(`GitHub fallback failed: HTTP ${response.status}`, 502);
    }

    const headers = responseHeadersWithDefaults(response.headers, {
        'accept-ranges': 'bytes',
    });
    headers.set('cache-control', defaultCacheControl(fileName, env));

    return new Response(request.method === 'HEAD' ? null : response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}

async function cachedResponse(request) {
    if (!canUseWorkerCache(request) || !globalThis.caches?.default) {
        return null;
    }

    return (await globalThis.caches.default.match(cacheKeyFor(request))) ?? null;
}

function cacheResponse(request, context, response) {
    if (
        request.method !== 'GET' ||
        !canUseWorkerCache(request) ||
        response.status !== 200 ||
        !globalThis.caches?.default ||
        !context?.waitUntil
    ) {
        return;
    }

    context.waitUntil(globalThis.caches.default.put(cacheKeyFor(request), response.clone()));
}

export async function handleUpdateProxyRequest(request, env, context) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        return textResponse('Method not allowed', 405, { allow: 'GET, HEAD' });
    }

    const parsed = objectKeyFromRequest(new URL(request.url), env.UPDATE_BASE_PATH);
    if (!parsed) {
        return textResponse('Not found', 404);
    }

    const r2Response = await responseFromR2(request, env, parsed.key, parsed.fileName);
    if (r2Response) {
        return r2Response;
    }

    if (isFeedFile(parsed.fileName)) {
        return textResponse('Not found', 404);
    }

    const cacheHit = await cachedResponse(request);
    if (cacheHit) {
        return request.method === 'HEAD'
            ? new Response(null, {
                  status: cacheHit.status,
                  statusText: cacheHit.statusText,
                  headers: cacheHit.headers,
              })
            : cacheHit;
    }

    const githubResponse = await responseFromGitHub(request, env, parsed.fileName);
    if (!githubResponse) {
        return textResponse('Not found', 404);
    }

    cacheResponse(request, context, githubResponse);
    return githubResponse;
}

export default {
    fetch: handleUpdateProxyRequest,
};
