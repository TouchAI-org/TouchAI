import { describe, expect, it, vi } from 'vitest';

import {
    assertSameOrigin,
    createGuardedFetch,
    isLoopbackExternalAgentUrl,
    parseExternalAgentUrl,
} from '@/modules/tools/external-agents/urlPolicy';

describe('given a user enters an external agent URL', () => {
    it('user gets a safe URL after confirming an IPv6 loopback agent', () => {
        const url = parseExternalAgentUrl('http://[::1]:8080/agent', true);

        expect(url.hostname).toBe('[::1]');
        expect(isLoopbackExternalAgentUrl(url)).toBe(true);
        expect(isLoopbackExternalAgentUrl(new URL('https://example.com'))).toBe(false);
    });

    it.each([
        ['a malformed URL', 'not a URL'],
        ['an insecure public URL', 'http://example.com/agent'],
        ['a credential-bearing URL', 'https://user:password@example.com/agent'],
    ])('user sees %s rejected before any request', (_case, input) => {
        expect(() => parseExternalAgentUrl(input, false)).toThrow('unsafe_url');
    });

    it('user sees an unconfirmed loopback agent rejected before any request', () => {
        expect(() => parseExternalAgentUrl('http://127.0.0.1:8080', false)).toThrow('unsafe_url');
    });

    it('user sees responses from a different origin rejected', () => {
        expect(() =>
            assertSameOrigin(
                new URL('https://example.com/start'),
                new URL('https://other.example.com/result')
            )
        ).toThrow('unsafe_url');
        expect(() =>
            assertSameOrigin(
                new URL('https://example.com/start'),
                new URL('https://example.com/result')
            )
        ).not.toThrow();
    });
});

describe('given a user invokes an external agent', () => {
    it.each(['Authorization', 'Cookie', 'Proxy-Authorization', 'X-Api-Key'])(
        'user sees a %s header rejected before the request is sent',
        async (header) => {
            const fetchImpl = vi.fn();
            const guardedFetch = createGuardedFetch(fetchImpl as unknown as typeof fetch, {
                allowLoopback: false,
            });

            await expect(
                guardedFetch('https://example.com/message:send', {
                    headers: { [header]: 'secret' },
                })
            ).rejects.toThrow('auth_required');
            expect(fetchImpl).not.toHaveBeenCalled();
        }
    );

    it('user sees a same-origin redirect followed without forwarding a POST body', async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce(
                new Response(null, {
                    status: 303,
                    headers: { Location: '/message:result' },
                })
            )
            .mockResolvedValueOnce(new Response('complete', { status: 200 }));
        const guardedFetch = createGuardedFetch(fetchImpl as unknown as typeof fetch, {
            allowLoopback: false,
        });

        const response = await guardedFetch('https://example.com/message:send', {
            method: 'POST',
            body: 'payload',
        });

        expect(await response.text()).toBe('complete');
        expect(fetchImpl).toHaveBeenNthCalledWith(
            2,
            'https://example.com/message:result',
            expect.objectContaining({ method: 'GET', body: undefined, redirect: 'manual' })
        );
    });

    it('user sees a redirect without a target rejected', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 307 }));
        const guardedFetch = createGuardedFetch(fetchImpl as unknown as typeof fetch, {
            allowLoopback: false,
        });

        await expect(guardedFetch('https://example.com/start')).rejects.toThrow('unsafe_url');
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('user sees more than three redirects rejected', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(
            new Response(null, {
                status: 307,
                headers: { Location: '/again' },
            })
        );
        const guardedFetch = createGuardedFetch(fetchImpl as unknown as typeof fetch, {
            allowLoopback: false,
        });

        await expect(guardedFetch('https://example.com/start')).rejects.toThrow('unsafe_url');
        expect(fetchImpl).toHaveBeenCalledTimes(4);
    });

    it('user sees a normal response returned unchanged', async () => {
        const expected = new Response('ready', { status: 200 });
        const fetchImpl = vi.fn().mockResolvedValue(expected);
        const guardedFetch = createGuardedFetch(fetchImpl as unknown as typeof fetch, {
            allowLoopback: false,
        });

        await expect(guardedFetch('https://example.com/start')).resolves.toBe(expected);
    });
});
