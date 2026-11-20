import { listen } from '@tauri-apps/api/event';
import { createWebSearchToolsFixture } from '@tests/utils/webSearchTools';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppEvent, eventService } from '@/app/workflows/windows/events';

const { readSettings, fetchSearch } = vi.hoisted(() => ({
    readSettings: vi.fn(async () => null as string | null),
    fetchSearch: vi.fn(),
}));

vi.mock('@/platform/http', () => ({
    createTauriFetch: () => fetchSearch,
    cancelResponseBody: vi.fn(async () => {}),
}));

describe('user watches a live search from the routing diagram', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        readSettings.mockResolvedValue(null);
    });

    it('user starts a search and receives its real branch followed by unique result sites', async () => {
        const events: Record<string, unknown>[] = [];
        const stop = await listen<Record<string, unknown>>('web-search:activity', ({ payload }) =>
            events.push(payload)
        );
        fetchSearch.mockResolvedValue(
            new Response(
                JSON.stringify({
                    results: [
                        { title: 'One', url: 'https://example.com/one?q=private' },
                        { title: 'Two', url: 'https://example.com/two' },
                        { title: 'Three', url: 'https://example.org/three' },
                    ],
                })
            )
        );
        const result = await executeWebSearchTool(
            { query: 'private query', provider: 'anysearch', source: 'academic' },
            {},
            { callId: 'activity-1', iteration: 1 }
        );
        await vi.waitFor(() => expect(events).toHaveLength(2));
        expect(result.isError).toBe(false);
        expect(events[0]).toMatchObject({
            phase: 'searching',
            source: 'academic',
            provider: 'anysearch',
            sites: [],
        });
        expect(events[1]).toMatchObject({
            id: events[0]!.id,
            phase: 'results',
            source: 'academic',
            sites: [{ url: 'https://example.com' }, { url: 'https://example.org' }],
        });
        expect(JSON.stringify(events)).not.toContain('private');
        stop();
    });

    it('user encounters a failed search and receives a stop without fabricated site logos', async () => {
        const events: Record<string, unknown>[] = [];
        const stop = await listen<Record<string, unknown>>('web-search:activity', ({ payload }) =>
            events.push(payload)
        );
        fetchSearch.mockRejectedValue(new Error('Unavailable'));
        const result = await executeWebSearchTool(
            { query: 'q', provider: 'anysearch', intent: 'technical' },
            {},
            { callId: 'activity-2', iteration: 1 }
        );
        await vi.waitFor(() => expect(events).toHaveLength(2));
        expect(result.isError).toBe(true);
        expect(events[1]).toMatchObject({ phase: 'stopped', source: 'code', sites: [] });
        stop();
    });

    it('user loses the animation channel and still receives search results', async () => {
        const { interceptTauriInvoke } = await import('@tests/utils/tauri');
        interceptTauriInvoke((call, next) => {
            if (call.cmd === 'plugin:event|emit') throw new Error('Window closed');
            return next();
        });
        fetchSearch.mockResolvedValue(
            new Response(
                JSON.stringify({ results: [{ title: 'One', url: 'https://example.com/one' }] })
            )
        );
        const result = await executeWebSearchTool(
            { query: 'q', provider: 'anysearch' },
            {},
            { callId: 'activity-3', iteration: 1 }
        );
        expect(result.isError).toBe(false);
    });

    it('user cancels a running search and its travelling request is stopped', async () => {
        const events: Record<string, unknown>[] = [];
        const stop = await listen<Record<string, unknown>>('web-search:activity', ({ payload }) =>
            events.push(payload)
        );
        fetchSearch.mockImplementation(
            (_url: string, init: RequestInit) =>
                new Promise((_resolve, reject) => {
                    init.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
                        once: true,
                    });
                })
        );
        const controller = new AbortController();
        const pending = executeWebSearchTool(
            { query: 'q', provider: 'anysearch' },
            {},
            { callId: 'cancelled', iteration: 1, signal: controller.signal }
        );
        await vi.waitFor(() => expect(events).toHaveLength(1));
        controller.abort();
        const result = await pending;
        expect(result.isError).toBe(true);
        expect(events[1]).toMatchObject({ id: events[0]!.id, phase: 'stopped', sites: [] });
        stop();
    });

    it('user searches with two engines in parallel and receives independent matching journeys', async () => {
        const events: Record<string, unknown>[] = [];
        const stop = await listen<Record<string, unknown>>('web-search:activity', ({ payload }) =>
            events.push(payload)
        );
        readSettings.mockResolvedValue(
            JSON.stringify({
                routingStrategy: 'priority',
                parallelProviders: true,
                parallelProviderCount: 2,
                providerPriority: ['anysearch', 'brave'],
                providers: { brave: { enabled: true, apiKey: 'test-key' } },
            })
        );
        fetchSearch.mockImplementation(
            async () =>
                new Response(
                    JSON.stringify({
                        results: [{ title: 'One', url: 'https://example.com/one' }],
                        web: { results: [{ title: 'Two', url: 'https://example.org/two' }] },
                    })
                )
        );
        const result = await executeWebSearchTool(
            { query: 'q', source: 'news' },
            {},
            { callId: 'parallel', iteration: 1 }
        );
        expect(result.isError).toBe(false);
        expect(events).toHaveLength(4);
        const starts = events.filter((event) => event.phase === 'searching');
        expect(new Set(starts.map((event) => event.id)).size).toBe(2);
        for (const start of starts) {
            expect(
                events.find((event) => event.id === start.id && event.phase === 'results')
            ).toMatchObject({ source: 'news', provider: start.provider });
        }
        stop();
    });
});

const { execute: executeWebSearchTool } = createWebSearchToolsFixture({
    configuration: { read: readSettings },
    activity: (event) => {
        void eventService.emit(AppEvent.WEB_SEARCH_ACTIVITY, event).catch(() => {});
    },
});
