import type { QuickSearchResult, QuickShortcutItem } from '@services/NativeService';
import { mountComposable } from '@tests/utils/composables';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

import { useQuickSearchLogic } from '@/views/SearchView/components/QuickSearchPanel/composables/useQuickSearchLogic';

const {
    assetLoaderMock,
    clickStatsMock,
    contextMenuCloseHandler,
    contextMenuOpenMock,
    layoutMock,
    useContextMenuMock,
} = vi.hoisted(() => {
    const closeHandler = {
        current: null as null | (() => void),
    };
    const openMock = vi.fn();
    const closeMock = vi.fn();

    return {
        assetLoaderMock: {
            iconMap: { value: {} as Record<string, string> },
            imagePreviewMap: { value: {} as Record<string, string> },
            isImageItem: vi.fn(() => false),
            getItemHoverTitle: vi.fn((item: QuickShortcutItem) => item.path),
            handleScroll: vi.fn(),
            scheduleIconLoad: vi.fn(),
            scheduleImageLoad: vi.fn(),
            flushPendingLoads: vi.fn(),
            resetLoadingState: vi.fn(),
            pruneIconMaps: vi.fn(),
        },
        clickStatsMock: {
            rankResults: vi.fn(async (_query: string, items: QuickShortcutItem[]) => items),
            recordClick: vi.fn(),
        },
        layoutMock: {
            scrollStyle: { value: {} },
            gridStyle: { value: {} },
            gridColumns: { value: 3 },
            gridGap: { value: 8 },
            selectionMaxHeight: { value: 320 },
            moveSelection: vi.fn(),
            setVisibleRows: vi.fn(),
            syncLayout: vi.fn().mockResolvedValue(undefined),
            updateLayout: vi.fn(),
            resetLayoutState: vi.fn(),
        },
        contextMenuCloseHandler: closeHandler,
        contextMenuOpenMock: openMock,
        useContextMenuMock: vi.fn((_items: unknown, _onSelect: unknown, onClose?: () => void) => {
            closeHandler.current = onClose ?? null;
            return {
                open: openMock,
                close: closeMock,
            };
        }),
    };
});

vi.mock('@/views/SearchView/components/QuickSearchPanel/composables/useAssetLoader', () => ({
    useAssetLoader: vi.fn(() => assetLoaderMock),
}));

vi.mock('@/views/SearchView/components/QuickSearchPanel/composables/useLayout', () => ({
    COLLAPSED_VISIBLE_ROWS: 5,
    useLayout: vi.fn(() => layoutMock),
}));

vi.mock(
    '@/views/SearchView/components/QuickSearchPanel/composables/useQuickSearchClickStats',
    () => ({
        useQuickSearchClickStats: vi.fn(() => clickStatsMock),
    })
);

vi.mock('@composables/useContextMenu', () => ({
    useContextMenu: useContextMenuMock,
}));

function createShortcut(name: string, path = `D:/${name}.lnk`): QuickShortcutItem {
    return {
        name,
        path,
        source: 'desktop_user',
    };
}

function createSearchResult(
    shortcuts: QuickShortcutItem[] = [],
    files: QuickShortcutItem[] = [],
    overrides: Partial<QuickSearchResult> = {}
): QuickSearchResult {
    return {
        shortcuts,
        files,
        total_files: files.length,
        total_results: shortcuts.length + files.length,
        next_offset: files.length,
        ...overrides,
    };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
        resolve = r;
    });

    return {
        promise,
        resolve,
    };
}

async function flushAsyncWork() {
    await Promise.resolve();
    await Promise.resolve();
}

describe('useQuickSearchLogic', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        contextMenuCloseHandler.current = null;
        clickStatsMock.rankResults.mockImplementation(async (_query, items) => items);
        delete (window as Window & { __TOUCHAI_E2E__?: unknown }).__TOUCHAI_E2E__;
    });

    afterEach(() => {
        vi.useRealTimers();
        delete (window as Window & { __TOUCHAI_E2E__?: unknown }).__TOUCHAI_E2E__;
        document.body.innerHTML = '';
    });

    it('debounces a search query, opens the panel, and stores the ranked results', async () => {
        const open = ref(false);
        const searchQuery = ref('');
        const quickSearchDeps = {
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
            },
            window: {
                hideSearchWindow: vi.fn().mockResolvedValue(undefined),
            },
            openPath: vi.fn().mockResolvedValue(undefined),
        };

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
                quickSearchDeps
            )
        );

        searchQuery.value = 'touchai';
        mounted.result.triggerSearch('touchai');
        await vi.advanceTimersByTimeAsync(80);
        await flushAsyncWork();

        expect(quickSearchDeps.quickSearch.searchShortcuts).toHaveBeenCalledWith('touchai', 60, 0);
        expect(open.value).toBe(true);
        expect(mounted.result.results.value).toEqual([createShortcut('TouchAI')]);
        expect(mounted.result.highlightedIndex.value).toBe(-1);
        expect(layoutMock.setVisibleRows).toHaveBeenCalledWith(5);
        expect(assetLoaderMock.scheduleIconLoad).toHaveBeenCalled();
        expect(assetLoaderMock.scheduleImageLoad).toHaveBeenCalled();

        mounted.unmount();
    });

    it('keeps only the latest pending query when a slower search result arrives late', async () => {
        const firstSearch = deferred<QuickSearchResult>();
        const secondSearch = deferred<QuickSearchResult>();
        const open = ref(false);
        const searchQuery = ref('');
        const quickSearchDeps = {
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
                    .mockImplementationOnce(() => firstSearch.promise)
                    .mockImplementationOnce(() => secondSearch.promise),
            },
            window: {
                hideSearchWindow: vi.fn().mockResolvedValue(undefined),
            },
            openPath: vi.fn().mockResolvedValue(undefined),
        };

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
                quickSearchDeps
            )
        );

        searchQuery.value = 'first';
        mounted.result.triggerSearch('first');
        await vi.advanceTimersByTimeAsync(80);
        await flushAsyncWork();

        searchQuery.value = 'second';
        mounted.result.triggerSearch('second');
        await vi.advanceTimersByTimeAsync(80);
        await flushAsyncWork();

        firstSearch.resolve(createSearchResult([createShortcut('First Result')]));
        await flushAsyncWork();

        secondSearch.resolve(createSearchResult([createShortcut('Second Result')]));
        await flushAsyncWork();

        expect(quickSearchDeps.quickSearch.searchShortcuts).toHaveBeenNthCalledWith(
            1,
            'first',
            60,
            0
        );
        expect(quickSearchDeps.quickSearch.searchShortcuts).toHaveBeenNthCalledWith(
            2,
            'second',
            60,
            0
        );
        expect(mounted.result.results.value).toEqual([createShortcut('Second Result')]);
        expect(open.value).toBe(true);

        mounted.unmount();
    });

    it('hides the panel when a query returns no results', async () => {
        const open = ref(true);
        const searchQuery = ref('');
        const quickSearchDeps = {
            quickSearch: {
                getStatus: vi.fn().mockResolvedValue({
                    provider: 'everything',
                    db_loaded: true,
                    index_warmed: true,
                    last_refresh_ms: null,
                    last_error: null,
                }),
                prepareIndex: vi.fn().mockResolvedValue(undefined),
                searchShortcuts: vi.fn().mockResolvedValue(createSearchResult()),
            },
            window: {
                hideSearchWindow: vi.fn().mockResolvedValue(undefined),
            },
            openPath: vi.fn().mockResolvedValue(undefined),
        };

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
                quickSearchDeps
            )
        );

        searchQuery.value = 'missing';
        mounted.result.triggerSearch('missing');
        await vi.advanceTimersByTimeAsync(80);
        await flushAsyncWork();

        expect(open.value).toBe(false);
        expect(mounted.result.results.value).toEqual([]);
        expect(assetLoaderMock.resetLoadingState).toHaveBeenCalled();

        mounted.unmount();
    });

    it('uses E2E fallback results when native quick search returns nothing', async () => {
        const open = ref(false);
        const searchQuery = ref('');
        const fallbackResult: QuickShortcutItem = {
            name: 'TouchAI E2E Smoke Result',
            path: 'C:/Windows/explorer.exe',
            source: 'file',
        };
        const quickSearchDeps = {
            quickSearch: {
                getStatus: vi.fn().mockResolvedValue({
                    provider: 'everything',
                    db_loaded: true,
                    index_warmed: true,
                    last_refresh_ms: null,
                    last_error: null,
                }),
                prepareIndex: vi.fn().mockResolvedValue(undefined),
                searchShortcuts: vi.fn().mockResolvedValue(createSearchResult()),
            },
            window: {
                hideSearchWindow: vi.fn().mockResolvedValue(undefined),
            },
            openPath: vi.fn().mockResolvedValue(undefined),
        };

        (
            window as Window & {
                __TOUCHAI_E2E__?: {
                    getQuickSearchFallbackResults?: (query: string) => QuickShortcutItem[];
                };
            }
        ).__TOUCHAI_E2E__ = {
            getQuickSearchFallbackResults: vi.fn((query: string) =>
                query === 'touchai' ? [fallbackResult] : []
            ),
        };

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
                quickSearchDeps
            )
        );

        searchQuery.value = 'touchai';
        mounted.result.triggerSearch('touchai');
        await vi.advanceTimersByTimeAsync(80);
        await flushAsyncWork();

        expect(open.value).toBe(true);
        expect(mounted.result.results.value).toEqual([fallbackResult]);
        expect(mounted.result.totalResults.value).toBe(1);

        mounted.unmount();
    });

    it('records the click and opens the highlighted result through the desktop boundary', async () => {
        const result = createShortcut('TouchAI');
        const open = ref(false);
        const searchQuery = ref('');
        const quickSearchDeps = {
            quickSearch: {
                getStatus: vi.fn().mockResolvedValue({
                    provider: 'everything',
                    db_loaded: true,
                    index_warmed: true,
                    last_refresh_ms: null,
                    last_error: null,
                }),
                prepareIndex: vi.fn().mockResolvedValue(undefined),
                searchShortcuts: vi.fn().mockResolvedValue(createSearchResult([result])),
            },
            window: {
                hideSearchWindow: vi.fn().mockResolvedValue(undefined),
            },
            openPath: vi.fn().mockResolvedValue(undefined),
        };

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
                quickSearchDeps
            )
        );

        searchQuery.value = 'touch';
        mounted.result.triggerSearch('touch');
        await vi.advanceTimersByTimeAsync(80);
        await flushAsyncWork();

        await mounted.result.handleItemClick(0);

        expect(clickStatsMock.recordClick).toHaveBeenCalledWith('touch', result.path);
        expect(quickSearchDeps.openPath).toHaveBeenCalledWith(result.path);

        mounted.unmount();
    });

    it('getNameSegments returns segments with match highlights', async () => {
        const open = ref(false);
        const searchQuery = ref('');
        const quickSearchDeps = {
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
            },
            window: {
                hideSearchWindow: vi.fn().mockResolvedValue(undefined),
            },
            openPath: vi.fn().mockResolvedValue(undefined),
        };

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
                quickSearchDeps
            )
        );

        searchQuery.value = 'touch';
        mounted.result.triggerSearch('touch');
        await vi.advanceTimersByTimeAsync(80);
        await flushAsyncWork();

        const segments = mounted.result.getNameSegments('TouchAI');
        expect(segments.length).toBeGreaterThan(0);
        expect(segments.some((s) => s.matched)).toBe(true);

        mounted.unmount();
    });

    it('skips re-search when the same query already has results', async () => {
        const open = ref(false);
        const searchQuery = ref('');
        const quickSearchDeps = {
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
            },
            window: {
                hideSearchWindow: vi.fn().mockResolvedValue(undefined),
            },
            openPath: vi.fn().mockResolvedValue(undefined),
        };

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
                quickSearchDeps
            )
        );

        searchQuery.value = 'touch';
        mounted.result.triggerSearch('touch');
        await vi.advanceTimersByTimeAsync(80);
        await flushAsyncWork();

        expect(quickSearchDeps.quickSearch.searchShortcuts).toHaveBeenCalledTimes(1);

        // Same query again should not trigger a new search.
        mounted.result.triggerSearch('touch');
        await vi.advanceTimersByTimeAsync(80);
        await flushAsyncWork();

        expect(quickSearchDeps.quickSearch.searchShortcuts).toHaveBeenCalledTimes(1);

        mounted.unmount();
    });

    it('collapseToDefault resets highlight and visible rows', async () => {
        const open = ref(false);
        const searchQuery = ref('');
        const quickSearchDeps = {
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
            },
            window: {
                hideSearchWindow: vi.fn().mockResolvedValue(undefined),
            },
            openPath: vi.fn().mockResolvedValue(undefined),
        };

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
                quickSearchDeps
            )
        );

        searchQuery.value = 'touch';
        mounted.result.triggerSearch('touch');
        await vi.advanceTimersByTimeAsync(80);
        await flushAsyncWork();

        mounted.result.collapseToDefault();

        expect(mounted.result.highlightedIndex.value).toBe(-1);
        expect(layoutMock.setVisibleRows).toHaveBeenCalledWith(5);
        expect(layoutMock.updateLayout).toHaveBeenCalled();

        mounted.unmount();
    });

    it('loadMore appends new file results', async () => {
        const open = ref(false);
        const searchQuery = ref('');
        const quickSearchDeps = {
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
                    .mockResolvedValueOnce(
                        createSearchResult(
                            [createShortcut('App')],
                            [createShortcut('File1', 'D:/File1.txt')],
                            { total_results: 10 }
                        )
                    )
                    .mockResolvedValueOnce(
                        createSearchResult([], [createShortcut('File2', 'D:/File2.txt')], {
                            total_results: 10,
                        })
                    ),
            },
            window: {
                hideSearchWindow: vi.fn().mockResolvedValue(undefined),
            },
            openPath: vi.fn().mockResolvedValue(undefined),
        };

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
                quickSearchDeps
            )
        );

        searchQuery.value = 'file';
        mounted.result.triggerSearch('file');
        await vi.advanceTimersByTimeAsync(80);
        await flushAsyncWork();

        expect(mounted.result.results.value.length).toBe(2);

        await mounted.result.loadMore();
        await flushAsyncWork();

        expect(mounted.result.results.value.length).toBe(3);
        expect(quickSearchDeps.quickSearch.searchShortcuts).toHaveBeenCalledTimes(2);

        mounted.unmount();
    });

    it('handleContextMenu sets highlight and opens context menu', async () => {
        const open = ref(false);
        const searchQuery = ref('');
        const quickSearchDeps = {
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
                    .mockResolvedValue(createSearchResult([createShortcut('App')])),
            },
            window: {
                hideSearchWindow: vi.fn().mockResolvedValue(undefined),
            },
            openPath: vi.fn().mockResolvedValue(undefined),
        };

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
                quickSearchDeps
            )
        );

        searchQuery.value = 'app';
        mounted.result.triggerSearch('app');
        await vi.advanceTimersByTimeAsync(80);
        await flushAsyncWork();

        const event = new MouseEvent('contextmenu', {
            clientX: 100,
            clientY: 100,
            bubbles: true,
        });
        mounted.result.handleContextMenu(event, 0);

        expect(mounted.result.highlightedIndex.value).toBe(0);

        mounted.unmount();
    });

    it('resets context menu state when the shared menu closes itself', async () => {
        const open = ref(false);
        const searchQuery = ref('');
        const quickSearchDeps = {
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
                    .mockResolvedValue(createSearchResult([createShortcut('App')])),
            },
            window: {
                hideSearchWindow: vi.fn().mockResolvedValue(undefined),
            },
            openPath: vi.fn().mockResolvedValue(undefined),
        };

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
                quickSearchDeps
            )
        );

        searchQuery.value = 'app';
        mounted.result.triggerSearch('app');
        await vi.advanceTimersByTimeAsync(80);
        await flushAsyncWork();

        mounted.result.handleContextMenu(
            new MouseEvent('contextmenu', {
                clientX: 100,
                clientY: 100,
                bubbles: true,
            }),
            0
        );

        expect(mounted.result.isContextMenuOpen.value).toBe(true);
        expect(contextMenuOpenMock).toHaveBeenCalled();

        contextMenuCloseHandler.current?.();

        expect(mounted.result.isContextMenuOpen.value).toBe(false);

        mounted.unmount();
    });

    it('open watcher triggers syncLayout on first open with no results', async () => {
        const open = ref(false);
        const searchQuery = ref('');
        const quickSearchDeps = {
            quickSearch: {
                getStatus: vi.fn().mockResolvedValue({
                    provider: 'everything',
                    db_loaded: true,
                    index_warmed: true,
                    last_refresh_ms: null,
                    last_error: null,
                }),
                prepareIndex: vi.fn().mockResolvedValue(undefined),
                searchShortcuts: vi.fn().mockResolvedValue(createSearchResult()),
            },
            window: {
                hideSearchWindow: vi.fn().mockResolvedValue(undefined),
            },
            openPath: vi.fn().mockResolvedValue(undefined),
        };

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
                quickSearchDeps
            )
        );

        // Open with no results should call syncLayout.
        open.value = true;
        await flushAsyncWork();

        expect(layoutMock.syncLayout).toHaveBeenCalled();

        mounted.unmount();
    });

    it('close resets lastSearchedQuery and allows re-search', async () => {
        const open = ref(false);
        const searchQuery = ref('');
        const quickSearchDeps = {
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
                    .mockResolvedValue(createSearchResult([createShortcut('App')])),
            },
            window: {
                hideSearchWindow: vi.fn().mockResolvedValue(undefined),
            },
            openPath: vi.fn().mockResolvedValue(undefined),
        };

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
                quickSearchDeps
            )
        );

        searchQuery.value = 'app';
        mounted.result.triggerSearch('app');
        await vi.advanceTimersByTimeAsync(80);
        await flushAsyncWork();

        expect(quickSearchDeps.quickSearch.searchShortcuts).toHaveBeenCalledTimes(1);

        // Close clears lastSearchedQuery.
        mounted.result.close();
        await flushAsyncWork();

        // Re-trigger same query should search again.
        open.value = false;
        await flushAsyncWork();
        open.value = true;
        searchQuery.value = 'app';
        mounted.result.triggerSearch('app');
        await vi.advanceTimersByTimeAsync(80);
        await flushAsyncWork();

        expect(quickSearchDeps.quickSearch.searchShortcuts).toHaveBeenCalledTimes(2);

        mounted.unmount();
    });
});
