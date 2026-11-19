import { AppEvent, eventService } from '@services/EventService';
import type { WebSearchActivityEvent } from '@services/EventService/types';
import { log } from '@services/ObservabilityService';
import type { SearchProviderId } from '@services/SettingsService/domain';

import type { WebSearchRequest, WebSearchResult } from './helper';

export function startSearchActivity(request: WebSearchRequest, provider: SearchProviderId) {
    const activity: WebSearchActivityEvent = {
        id: crypto.randomUUID(),
        source: request.source ?? (request.intent === 'technical' ? 'code' : request.intent),
        provider,
        phase: 'searching',
        sites: [],
        timeoutMs: request.timeoutMs,
    };
    const publish = (payload: WebSearchActivityEvent) => {
        // Window notifications must never delay or fail a search.
        void eventService.emit(AppEvent.WEB_SEARCH_ACTIVITY, payload).catch(() => {
            log.warn('[WebSearch] Could not update the search animation');
        });
    };
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
