import type { QuickSearchResult, QuickShortcutItem } from '@services/NativeService';
import { mountComposable } from '@tests/utils/composables';
import { deferred, installProductAnalytics } from '@tests/utils/productAnalytics';
import { mockTauriCommand } from '@tests/utils/tauri';
import { flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

import { useQuickSearchLogic } from '@/views/SearchView/components/QuickSearchPanel/composables/useQuickSearchLogic';

const { openPath, revealItemInDir } = vi.hoisted(() => ({
    openPath: vi.fn(),
    revealItemInDir: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-opener', () => ({ openPath, revealItemInDir }));

function searchResult(count = 1): QuickSearchResult {
    return {
        shortcuts: Array.from(
            { length: count },
            (_, index): QuickShortcutItem => ({
                name: `Result ${index}`,
                path: `D:/private-${index}.lnk`,
                source: 'desktop_user',
            })
        ),
        files: [],
        total_files: 0,
        total_results: count,
        next_offset: 0,
    };
}

async function mountSearch() {
    const open = ref(false);
    const searchQuery = ref('touchai');
    const mounted = await mountComposable(() =>
        useQuickSearchLogic({
            open,
            searchQuery,
            enabled: ref(true),
            emitOpenUpdate: (value) => {
                open.value = value;
            },
        })
    );
    return { ...mounted, isOpen: open, searchQuery };
}

async function showResults(search: Awaited<ReturnType<typeof mountSearch>>, query = 'touchai') {
    search.searchQuery.value = query;
    search.result.triggerSearch(query);
    await vi.advanceTimersByTimeAsync(80);
    await flushPromises();
    expect(search.result.results.value.length).toBeGreaterThan(0);
}

describe('user searches in quick search', () => {
    let telemetry: ReturnType<typeof installProductAnalytics>;
    const unmounts: Array<() => void> = [];

    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            queueMicrotask(() => callback(performance.now()));
            return 0;
        });
        vi.stubGlobal('cancelAnimationFrame', () => undefined);
        telemetry = installProductAnalytics();
        openPath.mockResolvedValue(undefined);
        revealItemInDir.mockResolvedValue(undefined);
        mockTauriCommand('quick_search_search_shortcuts', searchResult());
        mockTauriCommand('quick_search_get_status', {
            provider: 'everything',
            db_loaded: true,
            index_warmed: true,
            last_refresh_ms: null,
            last_error: null,
        });
        mockTauriCommand('database_query', { rows: [], rowsAffected: 0, lastInsertId: null });
        mockTauriCommand('quick_search_get_shortcut_icons', {});
        mockTauriCommand('quick_search_get_image_thumbnails', {});
    });

    afterEach(() => {
        unmounts.forEach((unmount) => unmount());
        unmounts.length = 0;
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    async function search() {
        const mounted = await mountSearch();
        unmounts.push(mounted.unmount);
        return mounted;
    }
    const completed = () =>
        telemetry.events.filter((event) => event.eventName === 'search.completed');
    const selected = () =>
        telemetry.events.filter((event) => event.eventName === 'search.result_selected');

    it('user gets one settled search when selecting a result and then closing the panel', async () => {
        const mounted = await search();
        await showResults(mounted);
        await mounted.result.handleItemClick(0);
        mounted.result.close();
        await flushPromises();

        expect(completed()).toHaveLength(1);
        expect(selected()).toHaveLength(1);
        expect(selected()[0]?.attributes).toMatchObject({
            interaction_id: completed()[0]?.attributes.interaction_id,
            result_category: 'file',
            opened: true,
        });
        expect(telemetry.released).toEqual(['operation-1']);
    });

    it('user keeps a pending pointer selection on its original panel after closing and reopening', async () => {
        const opening = deferred<void>();
        openPath.mockReturnValueOnce(opening.promise);
        const mounted = await search();
        await showResults(mounted);
        const selecting = mounted.result.handleItemClick(0);
        mounted.result.close();
        await showResults(mounted, 'reopened');
        expect(telemetry.released).toEqual([]);

        opening.resolve();
        await selecting;
        await flushPromises();
        expect(selected().map((event) => event.operationId)).toEqual(['operation-1']);
        expect(telemetry.active.has('operation-2')).toBe(true);
        mounted.result.close();
        await flushPromises();
        expect(completed().map((event) => event.operationId)).toEqual([
            'operation-1',
            'operation-2',
        ]);
        expect(telemetry.released).toEqual(['operation-1', 'operation-2']);
    });

    it('user keeps a pending keyboard selection when closing the panel and the opener fails', async () => {
        const opening = deferred<void>();
        openPath.mockReturnValueOnce(opening.promise);
        const mounted = await search();
        await showResults(mounted);
        mounted.result.highlightedIndex.value = 0;
        const selecting = mounted.result.openHighlightedItem();
        mounted.result.close();
        opening.reject(new Error('no handler'));
        await selecting;
        await flushPromises();

        expect(selected()[0]?.attributes.opened).toBe(false);
        expect(telemetry.released).toEqual(['operation-1']);
    });

    it.each(['succeeds in a pinned window', 'fails'])(
        'user keeps one interaction when a result open %s and the still open panel receives another query',
        async (outcome) => {
            if (outcome === 'fails') openPath.mockRejectedValueOnce(new Error('no handler'));
            const mounted = await search();
            await showResults(mounted);
            await mounted.result.handleItemClick(0);
            await flushPromises();
            expect(mounted.isOpen.value).toBe(true);
            await showResults(mounted, 'updated');
            mounted.result.close();
            await flushPromises();

            expect(completed()).toHaveLength(1);
            expect(selected()).toHaveLength(1);
            expect(
                telemetry.events.filter((event) => event.eventName === 'product.feature_exposed')
            ).toHaveLength(1);
            expect(telemetry.released).toEqual(['operation-1']);
            expect(telemetry.active.size).toBe(0);
        }
    );

    it('user gets one settled interaction when updating the query in an already open panel', async () => {
        const mounted = await search();
        await showResults(mounted);
        mockTauriCommand('quick_search_search_shortcuts', searchResult(3));
        await showResults(mounted, 'updated query');
        mounted.result.close();
        await flushPromises();

        expect(completed()).toHaveLength(1);
        expect(completed()[0]?.attributes.result_count_bucket).toBe('2-5');
        expect(telemetry.released).toEqual(['operation-1']);
    });

    it.each(['empty', 'failed'])(
        'user gets an empty settled search when the next query is %s after visible results',
        async (outcome) => {
            const mounted = await search();
            await showResults(mounted);
            mockTauriCommand('quick_search_search_shortcuts', () => {
                if (outcome === 'failed') throw new Error('index offline');
                return searchResult(0);
            });
            mounted.searchQuery.value = 'none';
            mounted.result.triggerSearch('none');
            await vi.advanceTimersByTimeAsync(80);
            await flushPromises();

            expect(mounted.isOpen.value).toBe(false);
            expect(completed()).toHaveLength(1);
            expect(completed()[0]?.attributes.has_results).toBe(false);
            expect(telemetry.released).toEqual(['operation-1']);
        }
    );

    it('user gets the pending selection outcome and cleanup even after leaving the page', async () => {
        const opening = deferred<void>();
        openPath.mockReturnValueOnce(opening.promise);
        const mounted = await mountSearch();
        await showResults(mounted);
        const selecting = mounted.result.handleItemClick(0);
        mounted.unmount();
        opening.resolve();
        await selecting;
        await flushPromises();
        expect(selected()[0]?.attributes.opened).toBe(true);
        expect(telemetry.active.size).toBe(0);
        expect(telemetry.released).toEqual(['operation-1']);
    });
});
