import type { QuickSearchResult, QuickShortcutItem } from '@services/NativeService';
import { mountComposable } from '@tests/utils/composables';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

const { interactionSpies, contextMenuSpies } = vi.hoisted(() => ({
    interactionSpies: {
        beginSearchInteraction: vi.fn(),
        settleSearchInteraction: vi.fn().mockResolvedValue(undefined),
        selectSearchResult: vi.fn().mockResolvedValue(undefined),
        finishSearchInteraction: vi.fn().mockResolvedValue(undefined),
        trackSearchFeatureExposed: vi.fn().mockResolvedValue(undefined),
        runResultAction: vi.fn().mockResolvedValue(undefined),
    },
    contextMenuSpies: {
        handler: null as null | ((key: string, item: QuickShortcutItem) => Promise<void>),
    },
}));

vi.mock('@services/AnalyticsService/productInteractions', () => ({
    beginSearchInteraction: interactionSpies.beginSearchInteraction,
    settleSearchInteraction: interactionSpies.settleSearchInteraction,
    selectSearchResult: interactionSpies.selectSearchResult,
    finishSearchInteraction: interactionSpies.finishSearchInteraction,
    trackSearchFeatureExposed: interactionSpies.trackSearchFeatureExposed,
    runResultAction: interactionSpies.runResultAction,
}));

vi.mock('@/views/SearchView/components/QuickSearchPanel/composables/useAssetLoader', () => ({
    useAssetLoader: vi.fn(() => ({
        iconMap: { value: {} },
        imagePreviewMap: { value: {} },
        isImageItem: vi.fn(() => false),
        getItemHoverTitle: vi.fn((item: QuickShortcutItem) => item.path),
        handleScroll: vi.fn(),
        scheduleIconLoad: vi.fn(),
        scheduleImageLoad: vi.fn(),
        flushPendingLoads: vi.fn(),
        resetLoadingState: vi.fn(),
        pruneIconMaps: vi.fn(),
    })),
}));

vi.mock('@/views/SearchView/components/QuickSearchPanel/composables/useLayout', () => ({
    COLLAPSED_VISIBLE_ROWS: 5,
    useLayout: vi.fn(() => ({
        scrollStyle: { value: {} },
        gridStyle: { value: {} },
        gridColumns: { value: 3 },
        gridGap: { value: 8 },
        selectionMaxHeight: { value: 320 },
        viewMode: { value: 'grid' },
        moveSelection: vi.fn(),
        setVisibleRows: vi.fn(),
        syncLayout: vi.fn().mockResolvedValue(undefined),
        updateLayout: vi.fn(),
        scrollHighlightedIntoView: vi.fn(),
        resetLayoutState: vi.fn(),
        toggleViewMode: vi.fn(),
    })),
}));

vi.mock(
    '@/views/SearchView/components/QuickSearchPanel/composables/useQuickSearchClickStats',
    () => ({
        useQuickSearchClickStats: vi.fn(() => ({
            rankResults: vi.fn(async (_query: string, items: QuickShortcutItem[]) => items),
            recordClick: vi.fn(),
        })),
    })
);

vi.mock('@composables/useContextMenu', () => ({
    useContextMenu: vi.fn(
        (_items: unknown, handler: (key: string, item: QuickShortcutItem) => Promise<void>) => {
            contextMenuSpies.handler = handler;
            return { open: vi.fn(), close: vi.fn() };
        }
    ),
}));

vi.mock('@services/ClipboardService', () => ({ clipboardService: { writeText: vi.fn() } }));

import { useQuickSearchLogic } from '@/views/SearchView/components/QuickSearchPanel/composables/useQuickSearchLogic';

function createShortcut(name: string, path = `D:/${name}.lnk`): QuickShortcutItem {
    return { name, path, source: 'desktop_user' };
}

function createSearchResult(shortcuts: QuickShortcutItem[]): QuickSearchResult {
    return {
        shortcuts,
        files: [],
        total_files: 0,
        total_results: shortcuts.length,
        next_offset: 0,
    };
}

function createInteraction() {
    return {
        operation: { operationId: 'op-1', enabled: true, consentEpoch: 2 },
        interactionId: 'interaction-1',
        scope: 'quick' as const,
        startedAtMs: 0,
        settled: false,
    };
}

async function mountQuickSearch(openPath: ReturnType<typeof vi.fn>) {
    const open = ref(false);
    const searchQuery = ref('');
    const mounted = await mountComposable(() =>
        useQuickSearchLogic(
            {
                open,
                searchQuery,
                enabled: ref(true),
                emitOpenUpdate: (value) => {
                    open.value = value;
                },
            },
            {
                quickSearch: {
                    getStatus: vi.fn().mockResolvedValue({
                        provider: 'everything',
                        db_loaded: true,
                        index_warmed: true,
                        last_refresh_ms: null,
                        last_error: null,
                    }),
                    prepareIndex: vi.fn().mockResolvedValue(undefined),
                    searchShortcuts: vi
                        .fn()
                        .mockResolvedValue(createSearchResult([createShortcut('TouchAI')])),
                } as never,
                window: { hideSearchWindow: vi.fn().mockResolvedValue(undefined) },
                openPath: openPath as never,
            }
        )
    );
    return { ...mounted, searchQuery };
}

async function flushAsyncWork() {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

describe('user searches in quick search', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        contextMenuSpies.handler = null;
        interactionSpies.beginSearchInteraction.mockImplementation(async () => createInteraction());
        interactionSpies.settleSearchInteraction.mockResolvedValue(undefined);
        interactionSpies.selectSearchResult.mockResolvedValue(undefined);
        interactionSpies.finishSearchInteraction.mockResolvedValue(undefined);
        interactionSpies.trackSearchFeatureExposed.mockResolvedValue(undefined);
        interactionSpies.runResultAction.mockResolvedValue(undefined);
    });

    afterEach(() => {
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    it('user gets one settled search when a result is selected and then the panel closes', async () => {
        const openPath = vi.fn().mockResolvedValue(undefined);
        const { result, searchQuery, unmount } = await mountQuickSearch(openPath);

        searchQuery.value = 'touchai';
        result.triggerSearch('touchai');
        await vi.advanceTimersByTimeAsync(80);
        await flushAsyncWork();

        await result.handleItemClick(0);
        await flushAsyncWork();

        result.close();
        await flushAsyncWork();

        expect(interactionSpies.beginSearchInteraction).toHaveBeenCalledWith('quick');
        expect(interactionSpies.settleSearchInteraction).toHaveBeenCalledTimes(1);
        expect(interactionSpies.settleSearchInteraction).toHaveBeenCalledWith(
            expect.objectContaining({ interactionId: 'interaction-1' }),
            { hasResults: true, resultCount: 1 }
        );
        expect(interactionSpies.selectSearchResult).toHaveBeenCalledWith(
            expect.objectContaining({ interactionId: 'interaction-1' }),
            { category: 'file', opened: true }
        );
        expect(interactionSpies.finishSearchInteraction).toHaveBeenCalledTimes(1);
        expect(interactionSpies.finishSearchInteraction).toHaveBeenCalledWith(
            expect.objectContaining({ interactionId: 'interaction-1' })
        );

        unmount();
    });

    it('user gets the quick search entry exposed once when usable results appear', async () => {
        const openPath = vi.fn().mockResolvedValue(undefined);
        const { result, searchQuery, unmount } = await mountQuickSearch(openPath);

        searchQuery.value = 'touchai';
        result.triggerSearch('touchai');
        await vi.advanceTimersByTimeAsync(80);
        await flushAsyncWork();

        expect(interactionSpies.trackSearchFeatureExposed).toHaveBeenCalledTimes(1);
        expect(interactionSpies.trackSearchFeatureExposed).toHaveBeenCalledWith(
            expect.objectContaining({
                operation: expect.objectContaining({ operationId: 'op-1' }),
            }),
            'quick_search'
        );

        unmount();
    });

    it('user gets a result marked not opened when the open action fails', async () => {
        const openPath = vi.fn().mockRejectedValue(new Error('no handler'));
        const { result, searchQuery, unmount } = await mountQuickSearch(openPath);

        searchQuery.value = 'touchai';
        result.triggerSearch('touchai');
        await vi.advanceTimersByTimeAsync(80);
        await flushAsyncWork();

        await result.handleItemClick(0);
        await flushAsyncWork();

        expect(interactionSpies.selectSearchResult).toHaveBeenCalledWith(
            expect.objectContaining({ interactionId: 'interaction-1' }),
            { category: 'file', opened: false }
        );

        unmount();
    });

    it('user gets a settled search on close without a selection', async () => {
        const openPath = vi.fn().mockResolvedValue(undefined);
        const { result, searchQuery, unmount } = await mountQuickSearch(openPath);

        searchQuery.value = 'touchai';
        result.triggerSearch('touchai');
        await vi.advanceTimersByTimeAsync(80);
        await flushAsyncWork();

        result.close();
        await flushAsyncWork();

        expect(interactionSpies.selectSearchResult).not.toHaveBeenCalled();
        expect(interactionSpies.settleSearchInteraction).toHaveBeenCalledTimes(1);
        expect(interactionSpies.finishSearchInteraction).toHaveBeenCalledTimes(1);

        unmount();
    });

    it('user gets an external-open result action when a result is revealed in the folder', async () => {
        const openPath = vi.fn().mockResolvedValue(undefined);
        const { unmount } = await mountQuickSearch(openPath);

        await contextMenuSpies.handler?.('open-folder', createShortcut('TouchAI'));

        expect(interactionSpies.runResultAction).toHaveBeenCalledWith(
            'open_external',
            expect.any(Function)
        );

        unmount();
    });

    it('user gets the path copy reported with the honest other category', async () => {
        const openPath = vi.fn().mockResolvedValue(undefined);
        const { unmount } = await mountQuickSearch(openPath);

        await contextMenuSpies.handler?.('copy-path', createShortcut('TouchAI'));

        expect(interactionSpies.runResultAction).toHaveBeenCalledWith(
            'other',
            expect.any(Function)
        );

        unmount();
    });
});
