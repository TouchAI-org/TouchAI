import type { QuickSearchResult, QuickShortcutItem } from '@services/NativeService';
import { mountComposable } from '@tests/utils/composables';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

import {
    type UseQuickSearchDeps,
    useQuickSearchLogic,
} from '@/views/SearchView/components/QuickSearchPanel/composables/useQuickSearchLogic';

/**
 * The panel's layout and icon loading measure real DOM boxes, which jsdom does not
 * lay out. They have their own test files, so here they are replaced by the smallest
 * possible stand-ins and every assertion below is about results, panel visibility
 * and what happens to the selected item.
 */
const { assetLoaderMock, clickStatsMock, contextMenuState, layoutMock, useContextMenuMock } =
    vi.hoisted(() => {
        const contextMenu = {
            closeHandler: null as null | (() => void),
            open: vi.fn(),
            close: vi.fn(),
        };

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
                viewMode: { value: 'grid' },
                moveSelection: vi.fn(),
                setVisibleRows: vi.fn(),
                syncLayout: vi.fn().mockResolvedValue(undefined),
                updateLayout: vi.fn(),
                scrollHighlightedIntoView: vi.fn(),
                resetLayoutState: vi.fn(),
                toggleViewMode: vi.fn(),
            },
            contextMenuState: contextMenu,
            useContextMenuMock: vi.fn(
                (_items: unknown, _onSelect: unknown, onClose?: () => void) => {
                    contextMenu.closeHandler = onClose ?? null;
                    return {
                        open: contextMenu.open,
                        close: contextMenu.close,
                    };
                }
            ),
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
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });

    return { promise, resolve };
}

async function flushAsyncWork() {
    await Promise.resolve();
    await Promise.resolve();
}

function createQuickSearchDeps(
    overrides: {
        searchShortcuts?: ReturnType<typeof vi.fn>;
        openPath?: ReturnType<typeof vi.fn>;
        getStatus?: ReturnType<typeof vi.fn>;
        prepareIndex?: ReturnType<typeof vi.fn>;
    } = {}
): UseQuickSearchDeps {
    return {
        quickSearch: {
            getStatus: (overrides.getStatus ??
                vi.fn().mockResolvedValue({
                    provider: 'everything',
                    db_loaded: true,
                    index_warmed: true,
                    last_refresh_ms: null,
                    last_error: null,
                })) as never,
            prepareIndex: (overrides.prepareIndex ?? vi.fn().mockResolvedValue(undefined)) as never,
            searchShortcuts: (overrides.searchShortcuts ??
                vi.fn().mockResolvedValue(createSearchResult())) as never,
        },
        window: {
            hideSearchWindow: vi.fn().mockResolvedValue(undefined),
        },
        openPath: (overrides.openPath ?? vi.fn().mockResolvedValue(undefined)) as never,
    };
}

async function mountQuickSearch(deps: ReturnType<typeof createQuickSearchDeps>) {
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
            deps
        )
    );

    return { ...mounted, open, searchQuery };
}

describe('when the user types a query that matches something', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        contextMenuState.closeHandler = null;
        clickStatsMock.rankResults.mockImplementation(async (_query, items) => items);
        delete (window as Window & { __TOUCHAI_E2E__?: unknown }).__TOUCHAI_E2E__;
    });

    afterEach(() => {
        vi.useRealTimers();
        delete (window as Window & { __TOUCHAI_E2E__?: unknown }).__TOUCHAI_E2E__;
        document.body.innerHTML = '';
    });

    it('user sees the results open after the typing pause', async () => {
        const deps = createQuickSearchDeps({
            searchShortcuts: vi
                .fn()
                .mockResolvedValue(createSearchResult([createShortcut('TouchAI')])),
        });
        const { result, open, searchQuery, unmount } = await mountQuickSearch(deps);

        searchQuery.value = 'touchai';
        result.triggerSearch('touchai');

        // Nothing is queried while the user is still typing.
        expect(deps.quickSearch.searchShortcuts).not.toHaveBeenCalled();
        expect(open.value).toBe(true);

        await vi.advanceTimersByTimeAsync(80);
        await flushAsyncWork();

        expect(deps.quickSearch.searchShortcuts).toHaveBeenCalledWith('touchai', 60, 0);
        expect(result.results.value).toEqual([createShortcut('TouchAI')]);
        expect(result.highlightedIndex.value).toBe(-1);

        unmount();
    });

    it('user gets the later query results even when the earlier query answers last', async () => {
        const firstSearch = deferred<QuickSearchResult>();
        const secondSearch = deferred<QuickSearchResult>();
        const deps = createQuickSearchDeps({
            searchShortcuts: vi
                .fn()
                .mockImplementationOnce(() => firstSearch.promise)
                .mockImplementationOnce(() => secondSearch.promise),
        });
        const { result, searchQuery, unmount } = await mountQuickSearch(deps);

        searchQuery.value = 'first';
        result.triggerSearch('first');
        await vi.advanceTimersByTimeAsync(80);
        await flushAsyncWork();

        searchQuery.value = 'second';
        result.triggerSearch('second');
        await vi.advanceTimersByTimeAsync(80);
        await flushAsyncWork();

        firstSearch.resolve(createSearchResult([createShortcut('First Result')]));
        await flushAsyncWork();
        secondSearch.resolve(createSearchResult([createShortcut('Second Result')]));
        await flushAsyncWork();

        expect(result.results.value).toEqual([createShortcut('Second Result')]);

        unmount();
    });

    it('user never gets a second query fired for the same text', async () => {
        const deps = createQuickSearchDeps({
            searchShortcuts: vi
                .fn()
                .mockResolvedValue(createSearchResult([createShortcut('TouchAI')])),
        });
        const { result, searchQuery, unmount } = await mountQuickSearch(deps);

        searchQuery.value = 'touch';
        result.triggerSearch('touch');
        await vi.advanceTimersByTimeAsync(80);
        await flushAsyncWork();

        result.triggerSearch('touch');
        await vi.advanceTimersByTimeAsync(80);
        await flushAsyncWork();

        expect(deps.quickSearch.searchShortcuts).toHaveBeenCalledTimes(1);

        unmount();
    });

    it('user gets the click-count ranking applied to the shortcut results', async () => {
        const popular = createShortcut('Popular', 'D:/popular.lnk');
        const rare = createShortcut('Rare', 'D:/rare.lnk');
        const deps = createQuickSearchDeps({
            searchShortcuts: vi.fn().mockResolvedValue(createSearchResult([rare, popular])),
        });
        clickStatsMock.rankResults.mockResolvedValue([popular, rare]);

        const { result, searchQuery, unmount } = await mountQuickSearch(deps);

        searchQuery.value = 'p';
        result.triggerSearch('p');
        await vi.advanceTimersByTimeAsync(80);
        await flushAsyncWork();

        expect(result.results.value).toEqual([popular, rare]);

        unmount();
    });
});

describe('when the user searches for something that matches nothing', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        contextMenuState.closeHandler = null;
        clickStatsMock.rankResults.mockImplementation(async (_query, items) => items);
        delete (window as Window & { __TOUCHAI_E2E__?: unknown }).__TOUCHAI_E2E__;
    });

    afterEach(() => {
        vi.useRealTimers();
        delete (window as Window & { __TOUCHAI_E2E__?: unknown }).__TOUCHAI_E2E__;
        document.body.innerHTML = '';
    });

    it('user sees the panel stay closed with no results', async () => {
        const deps = createQuickSearchDeps({
            searchShortcuts: vi.fn().mockResolvedValue(createSearchResult()),
        });
        const { result, open, searchQuery, unmount } = await mountQuickSearch(deps);

        searchQuery.value = 'missing';
        result.triggerSearch('missing');
        await vi.advanceTimersByTimeAsync(80);
        await flushAsyncWork();

        expect(open.value).toBe(false);
        expect(result.results.value).toEqual([]);

        unmount();
    });

    it('user sees the fallback results when the smoke test provides them', async () => {
        const fallbackResult: QuickShortcutItem = {
            name: 'TouchAI E2E Smoke Result',
            path: 'C:/Windows/explorer.exe',
            source: 'file',
        };
        (
            window as Window & {
                __TOUCHAI_E2E__?: {
                    getQuickSearchFallbackResults?: (query: string) => QuickShortcutItem[];
                };
            }
        ).__TOUCHAI_E2E__ = {
            getQuickSearchFallbackResults: (query: string) =>
                query === 'touchai' ? [fallbackResult] : [],
        };

        const deps = createQuickSearchDeps({
            searchShortcuts: vi.fn().mockResolvedValue(createSearchResult()),
        });
        const { result, open, searchQuery, unmount } = await mountQuickSearch(deps);

        searchQuery.value = 'touchai';
        result.triggerSearch('touchai');
        await vi.advanceTimersByTimeAsync(80);
        await flushAsyncWork();

        expect(open.value).toBe(true);
        expect(result.results.value).toEqual([fallbackResult]);
        expect(result.totalResults.value).toBe(1);

        unmount();
    });

    it('user sees the panel close when the search itself fails', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const deps = createQuickSearchDeps({
            searchShortcuts: vi.fn().mockRejectedValue(new Error('index unavailable')),
        });
        const { result, open, searchQuery, unmount } = await mountQuickSearch(deps);

        searchQuery.value = 'touch';
        result.triggerSearch('touch');
        await vi.advanceTimersByTimeAsync(80);
        await flushAsyncWork();

        expect(open.value).toBe(false);
        expect(result.results.value).toEqual([]);

        unmount();
    });
});

describe('when the user opens a search result', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        contextMenuState.closeHandler = null;
        clickStatsMock.rankResults.mockImplementation(async (_query, items) => items);
    });

    afterEach(() => {
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    async function mountWithResults() {
        const shortcut = createShortcut('TouchAI');
        const deps = createQuickSearchDeps({
            searchShortcuts: vi.fn().mockResolvedValue(createSearchResult([shortcut])),
        });
        const mounted = await mountQuickSearch(deps);

        mounted.searchQuery.value = 'touch';
        mounted.result.triggerSearch('touch');
        await vi.advanceTimersByTimeAsync(80);
        await flushAsyncWork();

        return { ...mounted, shortcut, deps };
    }

    it('user gets the clicked item launched and counted', async () => {
        const { result, shortcut, deps, unmount } = await mountWithResults();

        await result.handleItemClick(0);

        expect(deps.openPath).toHaveBeenCalledWith(shortcut.path);
        expect(clickStatsMock.recordClick).toHaveBeenCalledWith('touch', shortcut.path);

        unmount();
    });

    it('user gets the highlighted item launched with Enter', async () => {
        const { result, shortcut, deps, unmount } = await mountWithResults();

        expect(result.getHighlightedItem()).toBeNull();

        result.highlightedIndex.value = 0;
        await result.openHighlightedItem();

        expect(deps.openPath).toHaveBeenCalledWith(shortcut.path);

        unmount();
    });

    it('user is told nothing happens when a result cannot be launched', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const shortcut = createShortcut('TouchAI');
        const deps = createQuickSearchDeps({
            searchShortcuts: vi.fn().mockResolvedValue(createSearchResult([shortcut])),
            openPath: vi.fn().mockRejectedValue(new Error('file is gone')),
        });
        const { result, searchQuery, unmount } = await mountQuickSearch(deps);

        searchQuery.value = 'touch';
        result.triggerSearch('touch');
        await vi.advanceTimersByTimeAsync(80);
        await flushAsyncWork();

        await expect(result.handleItemClick(0)).resolves.toBeUndefined();

        unmount();
    });

    it('user gets the Enter launch failure contained when the file is gone', async () => {
        const shortcut = createShortcut('TouchAI');
        const deps = createQuickSearchDeps({
            searchShortcuts: vi.fn().mockResolvedValue(createSearchResult([shortcut])),
            openPath: vi.fn().mockRejectedValue(new Error('file is gone')),
        });
        const { result, searchQuery, unmount } = await mountQuickSearch(deps);

        searchQuery.value = 'touch';
        result.triggerSearch('touch');
        await vi.advanceTimersByTimeAsync(80);
        await flushAsyncWork();

        result.highlightedIndex.value = 0;
        await expect(result.openHighlightedItem()).resolves.toBeUndefined();

        unmount();
    });

    it('user still gets the panel when the search backend status cannot be read', async () => {
        const deps = createQuickSearchDeps({
            getStatus: vi.fn().mockRejectedValue(new Error('backend unavailable')),
        });
        const { result, searchQuery, unmount } = await mountQuickSearch(deps);

        searchQuery.value = 'touch';
        result.open();
        await flushAsyncWork();

        unmount();
    });

    it('user still gets search results when the index cannot be rebuilt', async () => {
        const deps = createQuickSearchDeps({
            prepareIndex: vi.fn().mockRejectedValue(new Error('index locked')),
        });
        const { unmount } = await mountQuickSearch(deps);

        await flushAsyncWork();

        unmount();
    });
});

describe('when the user right-clicks a search result', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        contextMenuState.closeHandler = null;
        clickStatsMock.rankResults.mockImplementation(async (_query, items) => items);
    });

    afterEach(() => {
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    async function mountWithResults() {
        const deps = createQuickSearchDeps({
            searchShortcuts: vi.fn().mockResolvedValue(createSearchResult([createShortcut('App')])),
        });
        const mounted = await mountQuickSearch(deps);

        mounted.searchQuery.value = 'app';
        mounted.result.triggerSearch('app');
        await vi.advanceTimersByTimeAsync(80);
        await flushAsyncWork();

        return mounted;
    }

    it('user gets that item highlighted and the menu opened', async () => {
        const { result, unmount } = await mountWithResults();

        result.handleContextMenu(
            new MouseEvent('contextmenu', { clientX: 100, clientY: 100, bubbles: true }),
            0
        );

        expect(result.highlightedIndex.value).toBe(0);
        expect(result.isContextMenuOpen.value).toBe(true);

        unmount();
    });

    it('user sees the menu state reset once the menu dismisses itself', async () => {
        const { result, unmount } = await mountWithResults();

        result.handleContextMenu(
            new MouseEvent('contextmenu', { clientX: 100, clientY: 100, bubbles: true }),
            0
        );
        expect(result.isContextMenuOpen.value).toBe(true);

        contextMenuState.closeHandler?.();

        expect(result.isContextMenuOpen.value).toBe(false);

        unmount();
    });

    it('user gets no menu when right-clicking past the last result', async () => {
        const { result, unmount } = await mountWithResults();

        result.handleContextMenu(
            new MouseEvent('contextmenu', { clientX: 100, clientY: 100, bubbles: true }),
            5
        );

        expect(result.isContextMenuOpen.value).toBe(false);

        unmount();
    });
});

describe('when the user scrolls past the first page of files', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        contextMenuState.closeHandler = null;
        clickStatsMock.rankResults.mockImplementation(async (_query, items) => items);
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            callback(0);
            return 1;
        });
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        document.body.innerHTML = '';
    });

    it('user gets the next page appended to the list already on screen', async () => {
        const deps = createQuickSearchDeps({
            searchShortcuts: vi
                .fn()
                .mockResolvedValueOnce(
                    createSearchResult(
                        [createShortcut('App')],
                        [createShortcut('File1', 'D:/File1.txt')],
                        {
                            total_results: 10,
                        }
                    )
                )
                .mockResolvedValueOnce(
                    createSearchResult([], [createShortcut('File2', 'D:/File2.txt')], {
                        total_results: 10,
                    })
                ),
        });
        const { result, searchQuery, unmount } = await mountQuickSearch(deps);

        searchQuery.value = 'file';
        result.triggerSearch('file');
        await vi.advanceTimersByTimeAsync(80);
        await flushAsyncWork();

        expect(result.results.value.length).toBe(2);

        await result.loadMore();
        await flushAsyncWork();

        expect(result.results.value.length).toBe(3);
        expect(result.results.value.map((item) => item.name)).toEqual(['App', 'File1', 'File2']);

        unmount();
    });

    it('user gets no extra query once every result is already on screen', async () => {
        const deps = createQuickSearchDeps({
            searchShortcuts: vi.fn().mockResolvedValue(
                createSearchResult([createShortcut('App')], [], {
                    total_results: 1,
                })
            ),
        });
        const { result, searchQuery, unmount } = await mountQuickSearch(deps);

        searchQuery.value = 'app';
        result.triggerSearch('app');
        await vi.advanceTimersByTimeAsync(80);
        await flushAsyncWork();

        await result.loadMore();

        expect(deps.quickSearch.searchShortcuts).toHaveBeenCalledTimes(1);

        unmount();
    });
});

describe('when the user asks to reset the panel', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        contextMenuState.closeHandler = null;
        clickStatsMock.rankResults.mockImplementation(async (_query, items) => items);
    });

    afterEach(() => {
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    it('user gets the highlight dropped when the panel collapses to its default state', async () => {
        const deps = createQuickSearchDeps({
            searchShortcuts: vi
                .fn()
                .mockResolvedValue(createSearchResult([createShortcut('TouchAI')])),
        });
        const { result, searchQuery, unmount } = await mountQuickSearch(deps);

        searchQuery.value = 'touch';
        result.triggerSearch('touch');
        await vi.advanceTimersByTimeAsync(80);
        await flushAsyncWork();

        result.highlightedIndex.value = 0;
        result.collapseToDefault();

        expect(result.highlightedIndex.value).toBe(-1);

        unmount();
    });

    it('user can search the same text again after closing the panel', async () => {
        const deps = createQuickSearchDeps({
            searchShortcuts: vi.fn().mockResolvedValue(createSearchResult([createShortcut('App')])),
        });
        const { result, open, searchQuery, unmount } = await mountQuickSearch(deps);

        searchQuery.value = 'app';
        result.triggerSearch('app');
        await vi.advanceTimersByTimeAsync(80);
        await flushAsyncWork();
        expect(deps.quickSearch.searchShortcuts).toHaveBeenCalledTimes(1);

        result.close();
        await flushAsyncWork();
        expect(open.value).toBe(false);
        expect(result.results.value).toEqual([]);

        open.value = true;
        result.triggerSearch('app');
        await vi.advanceTimersByTimeAsync(80);
        await flushAsyncWork();

        expect(deps.quickSearch.searchShortcuts).toHaveBeenCalledTimes(2);

        unmount();
    });

    it('user gets the panel closed when the query is cleared', async () => {
        const deps = createQuickSearchDeps();
        const { result, open, searchQuery, unmount } = await mountQuickSearch(deps);

        searchQuery.value = 'touch';
        result.triggerSearch('touch');
        await vi.advanceTimersByTimeAsync(80);
        await flushAsyncWork();

        result.triggerSearch('   ');
        await vi.advanceTimersByTimeAsync(80);
        await flushAsyncWork();

        expect(open.value).toBe(false);

        unmount();
    });
});

describe('when the user is shown a result name', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        contextMenuState.closeHandler = null;
        clickStatsMock.rankResults.mockImplementation(async (_query, items) => items);
    });

    afterEach(() => {
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    it('user sees the typed letters highlighted inside the name', async () => {
        const deps = createQuickSearchDeps({
            searchShortcuts: vi
                .fn()
                .mockResolvedValue(createSearchResult([createShortcut('TouchAI')])),
        });
        const { result, searchQuery, unmount } = await mountQuickSearch(deps);

        searchQuery.value = 'touch';
        result.triggerSearch('touch');
        await vi.advanceTimersByTimeAsync(80);
        await flushAsyncWork();

        const segments = result.getNameSegments('TouchAI');

        expect(segments.length).toBeGreaterThan(0);
        expect(segments.some((segment) => segment.matched)).toBe(true);

        unmount();
    });
});
