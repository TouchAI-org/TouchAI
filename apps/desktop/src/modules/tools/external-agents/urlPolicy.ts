import { inspectPublicUrl, isLoopbackHostname } from '../security/publicUrl';
import { ExternalAgentError } from './errors';

const CREDENTIAL_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization', 'x-api-key']);
const MAX_REDIRECTS = 3;

function stripIpv6Brackets(hostname: string): string {
    return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function assertSafeUrl(url: URL, allowLoopback: boolean): void {
    if (
        inspectPublicUrl(url, {
            allowLoopback,
            requireHttpsOutsideLoopback: true,
        })
    ) {
        throw new ExternalAgentError('unsafe_url');
    }
}

export function parseExternalAgentUrl(input: string, allowLoopback: boolean): URL {
    let url: URL;
    try {
        url = new URL(input);
    } catch (error) {
        throw new ExternalAgentError('unsafe_url', { cause: error });
    }
    assertSafeUrl(url, allowLoopback);
    return url;
}

export function isLoopbackExternalAgentUrl(url: URL): boolean {
    return isLoopbackHostname(stripIpv6Brackets(url.hostname));
}

export function assertSameOrigin(left: URL, right: URL): void {
    if (left.origin !== right.origin) throw new ExternalAgentError('unsafe_url');
}

function assertCredentialFree(headers: Headers): void {
    for (const [name] of headers) {
        if (CREDENTIAL_HEADERS.has(name.toLowerCase()))
            throw new ExternalAgentError('auth_required');
    }
}

/**
 * Applies the same host boundary as WebFetch before every A2A request and
 * redirect. A2A V1 intentionally sends no credentials.
 */
export function createGuardedFetch(
    fetchImpl: typeof fetch,
    options: { allowLoopback: boolean }
): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const request = input instanceof Request ? input : undefined;
        let current = new URL(request?.url ?? input.toString());
        let method = init?.method ?? request?.method ?? 'GET';
        let body = init?.body;
        const headers = new Headers(init?.headers ?? request?.headers);
        assertCredentialFree(headers);

        for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
            assertSafeUrl(current, options.allowLoopback);
            const response = await fetchImpl(current.toString(), {
                ...init,
                body,
                headers,
                method,
                redirect: 'manual',
            });
            if (![301, 302, 303, 307, 308].includes(response.status)) return response;

            await response.body?.cancel().catch(() => undefined);
            const location = response.headers.get('location');
            if (!location || redirects === MAX_REDIRECTS)
                throw new ExternalAgentError('unsafe_url');
            const next = new URL(location, current);
            assertSameOrigin(current, next);
            assertSafeUrl(next, options.allowLoopback);
            if (
                response.status === 303 ||
                ((response.status === 301 || response.status === 302) && method === 'POST')
            ) {
                method = 'GET';
                body = undefined;
            }
            current = next;
        }
        throw new ExternalAgentError('unsafe_url');
    }) as typeof fetch;
}
