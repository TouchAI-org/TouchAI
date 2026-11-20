export function tinyfishEndpoint(endpoint: string, operation: 'search' | 'fetch'): URL {
    const root = endpoint.trim().replace(/\/+$/, '');
    const official = `https://api.${operation}.tinyfish.ai/`;
    if (!root) return new URL(official);
    const url = new URL(root);
    if (
        ['api.search.tinyfish.ai', 'api.fetch.tinyfish.ai'].includes(url.hostname) &&
        !url.port &&
        /^\/(?:v1(?:\/(?:search|fetch))?)?$/.test(url.pathname)
    )
        return new URL(official);
    url.pathname = `${url.pathname.replace(/\/+$/, '').replace(/\/v1(?:\/(?:search|fetch))?$/, '')}/v1/${operation}`;
    return url;
}
