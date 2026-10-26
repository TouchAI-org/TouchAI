import type { QuickSearchResult, QuickShortcutItem } from '@services/NativeService';
import { mountComposable } from '@tests/utils/composables';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';

import { useQuickSearchLogic } from '@/views/SearchView/components/QuickSearchPanel/composables/useQuickSearchLogic';

/**
 * Branch pass over the quick-search flow: the empty-query guards, the stale-response
 * guards, the context-menu key routing, the panel open/close state sync and the
 * viewport-resize path. Layout measurement and icon loading are stubbed at the
 * module boundary; everything asserted is what the user sees in the panel.
 */
const { assetLoaderMock, clickStatsMock, contextMenuState, layoutMock, openPathMock } = vi.hoisted(
    () => ({
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
        contextMenuState: {
            open: vi.fn(),
            close: vi.fn(),
            closeHandler: null as null | (() => void),
        },
        layoutMock: {
            scrollStyle: { value: {} },
            gridStyle: { value: {} },
            gridColumns: { value: 3 },
            gridGap: { value: 8 },
            selectionMaxHeight: { value: 320 },
            viewMode: { value: 'grid' as 'grid' | 'list' },
            moveSelection: vi.fn(),
            setVisibleRows: vi.fn(),
            syncLayout: vi.fn().mockResolvedValue(undefined),
            updateLayout: vi.fn(),
            scrollHighlightedIntoView: vi.fn(),
            resetLayoutState: vi.fn(),
            toggleViewMode: vi.fn(),
        },
        openPathMock: vi.fn().mockResolvedValue(undefined),
    })
);

vi.mock('@/views/SearchView/components/QuickSearchPanel/composables/useAssetLoader', () => ({
    useAssetLoader: vi.fn(() => assetLoaderMock),
}));
vi.mock('@/views/SearchView/components/QuickSearchPanel/composables/useLayout', () => ({
    COLLAPSED_VISIBLE_ROWS: 5,
    useLayout: vi.fn(() => layoutMock),
}));
vi.mock(
    '@/views/SearchView/components/QuickSearchPanel/composables/useQuickSearchClickStats',
    () => ({ useQuickSearchClickStats: vi.fn(() => clickStatsMock) })
);
vi.mock('@composables/useContextMenu', () => ({
    useContextMenu: vi.fn((_items: unknown, _onSelect: unknown, onClose?: () => void) => {
        contextMenuState.closeHandler = onClose ?? null;
        return { open: contextMenuState.open, close: contextMenuState.close };
    }),
}));
vi.mock('@tauri-apps/plugin-opener', () => ({
    openPath: openPathMock,
    revealItemInDir: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@services/ClipboardService', () => ({
    clipboardService: { writeText: vi.fn().mockResolvedValue(undefined) },
}));

function createShortcut(name: string, path = `D:/${name}.lnk`): QuickShortcutItem {
    return { name, path, source: 'desktop_user' };
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

async function flushAsyncWork() {
    for (let index = 0; index < 4; index += 1) {
        await Promise.resolve();
        await nextTick();
    }
}

function createDeps(searchShortcuts?: ReturnType<typeof vi.fn>) {
    const search = searchShortcuts ?? vi.fn().mockResolvedValue(createSearchResult());
    return {
        searchShortcuts: search,
        quickSearch: {
            getStatus: vi.fn().mockResolvedValue({
                provider: 'everything',
                db_loaded: true,
                index_warmed: true,
                last_refresh_ms: null,
                last_error: null,
            }),
            prepareIndex: vi.fn().mockResolvedValue(undefined),
            searchShortcuts: search as never,
        },
        window: { hideSearchWindow: vi.fn().mockResolvedValue(undefined) },
        openPath: openPathMock as never,
    };
}

async function mountQuickSearch(deps: ReturnType<typeof createDeps>, enabled = ref(true)) {
    const open = ref(false);
    const searchQuery = ref('');

    const mounted = await mountComposable(() =>
        useQuickSearchLogic(
            {
                open,
                searchQuery,
                enabled,
                emitOpenUpdate: (value) => {
                    open.value = value;
                },
            },
            deps
        )
    );

    return { ...mounted, open, searchQuery, enabled };
}

async function mountWithResults(overrides: { searchShortcuts?: ReturnType<typeof vi.fn> } = {}) {
    const shortcut = createShortcut('TouchAI');
    const deps = createDeps(
        overrides.searchShortcuts ?? vi.fn().mockResolvedValue(createSearchResult([shortcut]))
    );
    const mounted = await mountQuickSearch(deps);

    mounted.searchQuery.value = 'touch';
    mounted.result.triggerSearch('touch');
    await vi.advanceTimersByTimeAsync(80);
    await flushAsyncWork();

    return { ...mounted, shortcut, deps };
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    contextMenuState.closeHandler = null;
    clickStatsMock.rankResults.mockImplementation(async (_query, items) => items);
    openPathMock.mockResolvedValue(undefined);
    delete (window as Window & { __TOUCHAI_E2E__?: unknown }).__TOUCHAI_E2E__;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
    });
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete (window as Window & { __TOUCHAI_E2E__?: unknown }).__TOUCHAI_E2E__;
    document.body.innerHTML = '';
});

describe('when a search is triggered with nothing typed', () => {
    it('user gets the panel closed for a blank query', async () => {
        const deps = createDeps();
        const { result, open, unmount } = await mountQuickSearch(deps);
        open.value = true;

        result.triggerSearch('   ');
        await vi.advanceTimersByTimeAsync(200);
        await flushAsyncWork();

        expect(open.value).toBe(false);
        expect(deps.searchShortcuts).not.toHaveBeenCalled();

        unmount();
    });

    it('user gets the panel closed when the panel opens with a blank query', async () => {
        const deps = createDeps();
        const { result, open, searchQuery, unmount } = await mountQuickSearch(deps);
        searchQuery.value = '   ';
        open.value = true;

        result.open();
        await flushAsyncWork();

        expect(open.value).toBe(false);

        unmount();
    });

    it('user gets no page jump for a blank query', async () => {
        const deps = createDeps();
        const { result, unmount } = await mountQuickSearch(deps);

        result.goToPage();
        await vi.advanceTimersByTimeAsync(200);

        expect(deps.searchShortcuts).not.toHaveBeenCalled();

        unmount();
    });
});

describe('when the panel is disabled', () => {
    it('user gets no panel opened while quick search is unavailable', async () => {
        const deps = createDeps();
        const { result, open, searchQuery, unmount } = await mountQuickSearch(deps, ref(false));
        searchQuery.value = 'touch';
        open.value = true;

        result.open();
        await flushAsyncWork();

        expect(open.value).toBe(true);
        expect(deps.searchShortcuts).not.toHaveBeenCalled();

        unmount();
    });
});

describe('when a response arrives for a superseded query', () => {
    it('user gets no results written from a response whose request id moved on', async () => {
        let resolveFirst: ((value: QuickSearchResult) => void) | null = null;
        const searchShortcuts = vi
            .fn()
            .mockImplementationOnce(
                () =>
                    new Promise<QuickSearchResult>((resolve) => {
                        resolveFirst = resolve;
                    })
            )
            .mockResolvedValue(createSearchResult([createShortcut('Fresh')]));
        const deps = createDeps(searchShortcuts);
        const { result, searchQuery, unmount } = await mountQuickSearch(deps);

        searchQuery.value = 'first';
        result.triggerSearch('first');
        await vi.advanceTimersByTimeAsync(80);

        // A newer query starts before the first response lands.
        searchQuery.value = 'second';
        result.triggerSearch('second');
        await vi.advanceTimersByTimeAsync(80);
        await flushAsyncWork();

        resolveFirst!(createSearchResult([createShortcut('Stale')]));
        await flushAsyncWork();

        expect(result.results.value.map((item) => item.name)).toEqual(['Fresh']);

        unmount();
    });

    it('user gets no error state when a search fails after the panel was closed', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        let rejectSearch: ((error: Error) => void) | null = null;
        const searchShortcuts = vi.fn(
            () =>
                new Promise<QuickSearchResult>((_resolve, reject) => {
                    rejectSearch = reject;
                })
        );
        const deps = createDeps(searchShortcuts);
        const { result, open, searchQuery, unmount } = await mountQuickSearch(deps);

        searchQuery.value = 'touch';
        result.triggerSearch('touch');
        await vi.advanceTimersByTimeAsync(80);

        // The user closes the panel while the query is still running.
        await result.close();
        expect(open.value).toBe(false);

        // The abandoned query then fails: the closed panel must stay closed and quiet.
        rejectSearch!(new Error('stale failure'));
        await flushAsyncWork();

        expect(open.value).toBe(false);
        expect(result.results.value).toEqual([]);

        unmount();
    });

    it('user gets no results kept when the query was cleared before the answer', async () => {
        let resolveSearch: ((value: QuickSearchResult) => void) | null = null;
        const searchShortcuts = vi.fn(
            () =>
                new Promise<QuickSearchResult>((resolve) => {
                    resolveSearch = resolve;
                })
        );
        const deps = createDeps(searchShortcuts);
        const { result, searchQuery, unmount } = await mountQuickSearch(deps);

        searchQuery.value = 'touch';
        result.triggerSearch('touch');
        await vi.advanceTimersByTimeAsync(80);

        searchQuery.value = '';
        resolveSearch!(createSearchResult([createShortcut('Late')]));
        await flushAsyncWork();

        expect(result.results.value).toEqual([]);

        unmount();
    });
});

describe('when the user right-clicks from the keyboard', () => {
    it('user gets the menu opened for the highlighted result', async () => {
        const { result, unmount } = await mountWithResults();
        const row = document.createElement('div');
        row.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 40 }) as DOMRect;
        result.itemRefs.value = [row];
        result.highlightedIndex.value = 0;

        result.openContextMenuForHighlightedItem();

        expect(contextMenuState.open).toHaveBeenCalled();
        expect(result.isContextMenuOpen.value).toBe(true);

        unmount();
    });

    it('user gets the menu closed when it dismisses itself', async () => {
        const { result, unmount } = await mountWithResults();
        const row = document.createElement('div');
        row.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 40 }) as DOMRect;
        result.itemRefs.value = [row];
        result.highlightedIndex.value = 0;
        result.openContextMenuForHighlightedItem();

        contextMenuState.closeHandler?.();

        expect(result.isContextMenuOpen.value).toBe(false);

        unmount();
    });

    it('user gets no menu for a result index that does not exist', async () => {
        const { result, unmount } = await mountWithResults();

        result.handleContextMenu(new MouseEvent('contextmenu'), 99);

        expect(contextMenuState.open).not.toHaveBeenCalled();
        expect(result.isContextMenuOpen.value).toBe(false);

        unmount();
    });
});

describe('when the user opens the highlighted result', () => {
    it('user gets nothing opened while no result is highlighted', async () => {
        const { result, unmount } = await mountWithResults();
        result.highlightedIndex.value = -1;

        await result.openHighlightedItem();

        expect(openPathMock).not.toHaveBeenCalled();

        unmount();
    });

    it('user gets nothing opened for a highlight past the last result', async () => {
        const { result, unmount } = await mountWithResults();
        result.highlightedIndex.value = 50;

        expect(result.getHighlightedItem()).toBeNull();
        await result.openHighlightedItem();

        expect(openPathMock).not.toHaveBeenCalled();

        unmount();
    });

    it('user gets nothing opened for a click index past the last result', async () => {
        const { result, unmount } = await mountWithResults();

        await result.handleItemClick(50);

        expect(openPathMock).not.toHaveBeenCalled();

        unmount();
    });
});

describe('when the panel open state changes', () => {
    it('user gets the layout refreshed when the panel reopens with results', async () => {
        const { result, open, unmount } = await mountWithResults();
        result.highlightedIndex.value = 0;
        layoutMock.updateLayout.mockClear();

        open.value = false;
        await nextTick();
        open.value = true;
        await nextTick();

        // Reopening with results already loaded re-measures instead of refetching.
        expect(layoutMock.updateLayout).toHaveBeenCalled();
        expect(layoutMock.scrollHighlightedIntoView).toHaveBeenCalled();

        unmount();
    });

    it('user gets the scroll position reset when the panel closes empty', async () => {
        const deps = createDeps();
        const { result, open, unmount } = await mountQuickSearch(deps);
        const scrollHost = document.createElement('div');
        scrollHost.scrollTop = 250;
        result.scrollRef.value = scrollHost;

        open.value = true;
        await nextTick();
        open.value = false;
        await nextTick();
        await flushAsyncWork();

        expect(scrollHost.scrollTop).toBe(0);

        unmount();
    });
});

describe('when the window is resized', () => {
    it('user gets the layout re-measured while the panel shows results', async () => {
        const { unmount } = await mountWithResults();
        layoutMock.updateLayout.mockClear();

        window.dispatchEvent(new Event('resize'));
        await nextTick();

        expect(layoutMock.updateLayout).toHaveBeenCalled();

        unmount();
    });

    it('user gets no re-measure while the panel is closed', async () => {
        const deps = createDeps();
        const { unmount } = await mountQuickSearch(deps);
        layoutMock.updateLayout.mockClear();

        window.dispatchEvent(new Event('resize'));
        await nextTick();

        expect(layoutMock.updateLayout).not.toHaveBeenCalled();

        unmount();
    });

    it('user gets no re-measure when the panel has no results', async () => {
        const { open, unmount } = await mountWithResults();
        layoutMock.updateLayout.mockClear();

        // Empty the results while keeping the panel open, then resize.
        open.value = false;
        await nextTick();
        window.dispatchEvent(new Event('resize'));
        await nextTick();

        expect(layoutMock.updateLayout).not.toHaveBeenCalled();

        unmount();
    });
});

describe('when the user collapses the panel to its default state', () => {
    it('user gets the scroll position reset and the highlight dropped', async () => {
        const { result, unmount } = await mountWithResults();
        const scrollHost = document.createElement('div');
        scrollHost.scrollTop = 400;
        result.scrollRef.value = scrollHost;
        result.highlightedIndex.value = 1;

        result.collapseToDefault();
        await nextTick();
        await flushAsyncWork();

        expect(result.highlightedIndex.value).toBe(-1);
        expect(scrollHost.scrollTop).toBe(0);

        unmount();
    });
});

describe('when the panel is torn down', () => {
    it('user gets the resize listener released', async () => {
        const { unmount } = await mountWithResults();
        const removeSpy = vi.spyOn(window, 'removeEventListener');

        unmount();

        expect(removeSpy).toHaveBeenCalledWith('resize', expect.any(Function));
    });
});
