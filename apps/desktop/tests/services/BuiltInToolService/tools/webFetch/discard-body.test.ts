import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale, t } from '@/i18n';
import { executeWebFetchTool } from '@/services/BuiltInToolService/tools/webFetch';
import { MAX_WEB_FETCH_REDIRECTS } from '@/services/BuiltInToolService/tools/webFetch/constants';

/**
 * The HTTP wrapper reads the upstream body on demand (pull-driven), so a response
 * that is discarded without being read leaves the native reader dangling. These
 * tests drive the real `createTauriFetch` and a controlled upstream stream, then
 * assert the consumer both reports the original outcome and cancels the reader.
 */
const { pluginFetch } = vi.hoisted(() => ({ pluginFetch: vi.fn() }));

vi.mock('@tauri-apps/plugin-http', () => ({ fetch: pluginFetch }));

const DISCARD_REASON = 'WebFetch response discarded';
const REDIRECT_REASON = 'WebFetch redirect';

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

function createExecutionContext(): Parameters<typeof executeWebFetchTool>[2] {
    return {
        signal: new AbortController().signal,
        callId: 'web-fetch-call',
        iteration: 1,
    };
}

describe('user asks the assistant to read a web page that is not consumed', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setLocale('en-US');
    });

    it('user gets the unsupported-content error and the unread body is released', async () => {
        const source = controlledStream();
        pluginFetch.mockResolvedValueOnce(
            new Response(source.stream, {
                status: 200,
                headers: { 'content-type': 'image/png' },
            })
        );

        const result = await executeWebFetchTool(
            { url: 'https://example.test/picture', mode: 'reader', maxChars: 1000 },
            {},
            createExecutionContext()
        );

        expect(result.isError).toBe(true);
        expect(result.errorMessage).toBe(
            t('builtInTools.webFetch.error.unsupportedContentType', { contentType: 'image/png' })
        );
        expect(source.cancelReasons).toEqual([DISCARD_REASON]);
    });

    it('user gets the reader fallback result and the blocked response body is released', async () => {
        const blocked = controlledStream();
        pluginFetch
            .mockResolvedValueOnce(
                new Response(blocked.stream, {
                    status: 403,
                    statusText: 'Forbidden',
                    headers: { 'content-type': 'text/plain' },
                })
            )
            .mockResolvedValueOnce(
                new Response('# Reader result\n\nFetched by reader fallback.', {
                    status: 200,
                    headers: { 'content-type': 'text/markdown' },
                })
            );

        const result = await executeWebFetchTool(
            {
                url: 'https://blocked.example/article',
                mode: 'reader',
                maxChars: 2000,
                enableThirdPartyReaderFallback: true,
            },
            {},
            createExecutionContext()
        );

        expect(result.isError).toBe(false);
        expect(result.result).toContain('Fetched by reader fallback.');
        expect(blocked.cancelReasons).toEqual([DISCARD_REASON]);
    });

    it('user gets the blocked-host error and the redirect body is released when the target is disallowed', async () => {
        const redirect = controlledStream();
        pluginFetch.mockResolvedValueOnce(
            new Response(redirect.stream, {
                status: 302,
                headers: { location: 'http://localhost/private' },
            })
        );

        const result = await executeWebFetchTool(
            { url: 'https://example.test/start', mode: 'reader', maxChars: 1000 },
            {},
            createExecutionContext()
        );

        expect(result.isError).toBe(true);
        expect(result.errorMessage).toBe(t('builtInTools.webFetch.error.blockedHost'));
        expect(redirect.cancelReasons).toEqual([REDIRECT_REASON]);
    });

    it('user gets the redirect-limit error and every discarded redirect body is released', async () => {
        const redirects = Array.from({ length: MAX_WEB_FETCH_REDIRECTS + 1 }, () =>
            controlledStream()
        );
        for (const [index, redirect] of redirects.entries()) {
            pluginFetch.mockResolvedValueOnce(
                new Response(redirect.stream, {
                    status: 302,
                    headers: { location: `/redirect-${index + 1}` },
                })
            );
        }

        const result = await executeWebFetchTool(
            { url: 'https://example.test/start', mode: 'reader', maxChars: 1000 },
            {},
            createExecutionContext()
        );

        expect(result.isError).toBe(true);
        expect(result.errorMessage).toBe(
            t('builtInTools.webFetch.error.tooManyRedirects', {
                maxRedirections: MAX_WEB_FETCH_REDIRECTS,
            })
        );
        expect(redirects.map((redirect) => redirect.cancelReasons)).toEqual(
            redirects.map(() => [REDIRECT_REASON])
        );
    });

    it('user gets the blocked response when the fallback is non-OK and the fallback body is released', async () => {
        const blocked = controlledStream();
        const fallback = controlledStream();
        pluginFetch
            .mockResolvedValueOnce(
                new Response(blocked.stream, {
                    status: 403,
                    statusText: 'Forbidden',
                    headers: { 'content-type': 'text/plain' },
                })
            )
            .mockResolvedValueOnce(
                new Response(fallback.stream, {
                    status: 503,
                    statusText: 'Service Unavailable',
                    headers: { 'content-type': 'text/plain' },
                })
            );

        const result = await executeWebFetchTool(
            {
                url: 'https://blocked.example/article',
                mode: 'reader',
                maxChars: 2000,
                enableThirdPartyReaderFallback: true,
            },
            {},
            createExecutionContext()
        );

        expect(result).toMatchObject({ isError: true, status: 'error' });
        expect(result.errorMessage).toBe('HTTP 403 Forbidden');
        expect(fallback.cancelReasons).toEqual([DISCARD_REASON]);
    });

    it('user gets the blocked response when the fallback is non-textual and the fallback body is released', async () => {
        const blocked = controlledStream();
        const fallback = controlledStream();
        pluginFetch
            .mockResolvedValueOnce(
                new Response(blocked.stream, {
                    status: 429,
                    statusText: 'Too Many Requests',
                    headers: { 'content-type': 'text/plain' },
                })
            )
            .mockResolvedValueOnce(
                new Response(fallback.stream, {
                    status: 200,
                    headers: { 'content-type': 'image/png' },
                })
            );

        const result = await executeWebFetchTool(
            {
                url: 'https://blocked.example/article',
                mode: 'reader',
                maxChars: 2000,
                enableThirdPartyReaderFallback: true,
            },
            {},
            createExecutionContext()
        );

        expect(result).toMatchObject({ isError: true, status: 'error' });
        expect(result.errorMessage).toBe('HTTP 429 Too Many Requests');
        expect(fallback.cancelReasons).toEqual([DISCARD_REASON]);
    });

    it('user gets the invalid-location error and the redirect body is released', async () => {
        const redirect = controlledStream();
        const location = 'http://[invalid';
        pluginFetch.mockResolvedValueOnce(
            new Response(redirect.stream, {
                status: 302,
                headers: { location },
            })
        );

        const result = await executeWebFetchTool(
            { url: 'https://example.test/start', mode: 'reader', maxChars: 1000 },
            {},
            createExecutionContext()
        );

        expect(result.isError).toBe(true);
        expect(result.errorMessage).toBe(
            t('builtInTools.webFetch.error.invalidUrl', { url: location })
        );
        expect(redirect.cancelReasons).toEqual([REDIRECT_REASON]);
    });
});
