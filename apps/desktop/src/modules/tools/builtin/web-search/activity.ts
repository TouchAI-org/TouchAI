import type { SearchProviderId, SearchSource } from './configuration';
export interface WebSearchActivityEvent {
    id: string;
    source: SearchSource;
    provider: SearchProviderId;
    phase: 'searching' | 'results' | 'stopped';
    sites: Array<{ url: string; favicon?: string }>;
    timeoutMs: number;
}

import type { WebSearchRequest, WebSearchResult } from './helper';

export function startSearchActivity(
    request: WebSearchRequest,
    provider: SearchProviderId,
    onActivity?: (event: WebSearchActivityEvent) => void
) {
    const activity: WebSearchActivityEvent = {
        id: crypto.randomUUID(),
        source: request.source ?? (request.intent === 'technical' ? 'code' : request.intent),
        provider,
        phase: 'searching',
        sites: [],
        timeoutMs: request.timeoutMs,
    };
    const publish = (event: WebSearchActivityEvent) => onActivity?.(event);
    publish(activity);
    return (results: WebSearchResult[] = []) => {
        const sites: WebSearchActivityEvent['sites'] = [];
        for (const result of results) {
            let url: URL;
            try {
                url = new URL(result.url);
            } catch {
                continue;
            }
            if (
                !['http:', 'https:'].includes(url.protocol) ||
                sites.some((site) => site.url === url.origin)
            )
                continue;
            const favicon =
                result.favicon && /^https?:\/\//i.test(result.favicon) ? result.favicon : undefined;
            sites.push({ url: url.origin, ...(favicon ? { favicon } : {}) });
            if (sites.length === 4) break;
        }
        publish({ ...activity, phase: sites.length ? 'results' : 'stopped', sites });
    };
}
