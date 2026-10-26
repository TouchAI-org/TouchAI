import type { QuickSearchResult, QuickShortcutItem } from '@services/NativeService';
import { mountComposable } from '@tests/utils/composables';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';

import { useQuickSearchLogic } from '@/views/SearchView/components/QuickSearchPanel/composables/useQuickSearchLogic';

/**
 * Quick search is a search-plus-launch flow. Layout measurement and icon loading
 * need real layout and are covered by their own files, so they are stubbed at the
 * module boundary; everything here is about results, panel visibility and the
 * actions a user triggers on a result (open, reveal, copy path, page through).
 */
const {
    assetLoaderMock,
    clickStatsMock,
    clipboardMock,
    contextMenuState,
    layoutMock,
    openPathMock,
    revealItemInDirMock,
} = vi.hoisted(() => ({
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
    clipboardMock: { writeText: vi.fn() },
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
    revealItemInDirMock: vi.fn().mockResolvedValue(undefined),
}));

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
    useContextMenu: vi.fn((_items: unknown, _onSelect: unknown, onClose?: () => void) => {
        contextMenuState.closeHandler = onClose ?? null;
        return { open: contextMenuState.open, close: contextMenuState.close };
    }),
}));

vi.mock('@tauri-apps/plugin-opener', () => ({
    openPath: openPathMock,
    revealItemInDir: revealItemInDirMock,
}));

vi.mock('@services/ClipboardService', () => ({
    clipboardService: clipboardMock,
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
    await Promise.resolve();
    await Promise.resolve();
}

function createDeps(
    overrides: {
        searchShortcuts?: ReturnType<typeof vi.fn>;
        openPath?: ReturnType<typeof vi.fn>;
    } = {}
) {
    const searchShortcuts =
        overrides.searchShortcuts ??
        vi
            .fn<(...args: unknown[]) => Promise<QuickSearchResult>>()
            .mockResolvedValue(createSearchResult());

    return {
        searchShortcuts,
        quickSearch: {
            getStatus: vi.fn().mockResolvedValue({
                provider: 'everything',
                db_loaded: true,
                index_warmed: true,
                last_refresh_ms: null,
                last_error: null,
            }),
            prepareIndex: vi.fn().mockResolvedValue(undefined),
            searchShortcuts: searchShortcuts as never,
        },
        window: { hideSearchWindow: vi.fn().mockResolvedValue(undefined) },
        openPath: (overrides.openPath ?? openPathMock) as never,
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

async function mountWithResults(
    overrides: {
        searchShortcuts?: ReturnType<typeof vi.fn>;
        openPath?: ReturnType<typeof vi.fn>;
        itemRects?: Array<Partial<DOMRect>>;
    } = {}
) {
    const shortcut = createShortcut('TouchAI');
    const deps = createDeps({
        searchShortcuts:
            overrides.searchShortcuts ?? vi.fn().mockResolvedValue(createSearchResult([shortcut])),
        openPath: overrides.openPath,
    });
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
    clipboardMock.writeText.mockResolvedValue(undefined);
    openPathMock.mockResolvedValue(undefined);
    revealItemInDirMock.mockResolvedValue(undefined);
    clickStatsMock.rankResults.mockImplementation(async (_query, items) => items);
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

describe('when the user acts on a result from the context menu', () => {
    it('user gets the containing folder opened in the file manager', async () => {
        const { shortcut, unmount } = await mountWithResults();

        // The menu items are built by the composable; selecting "open-folder" must
        // reveal the item rather than merely highlight it.
        const { useContextMenu } = await import('@composables/useContextMenu');
        const onSelect = (useContextMenu as unknown as ReturnType<typeof vi.fn>).mock
            .calls[0]![1] as (key: string, item: QuickShortcutItem) => Promise<void>;

        await onSelect('open-folder', shortcut);

        expect(revealItemInDirMock).toHaveBeenCalledWith(shortcut.path);

        unmount();
    });

    it('user gets the path copied to the clipboard', async () => {
        const { shortcut, unmount } = await mountWithResults();

        const { useContextMenu } = await import('@composables/useContextMenu');
        const onSelect = (useContextMenu as unknown as ReturnType<typeof vi.fn>).mock
            .calls[0]![1] as (key: string, item: QuickShortcutItem) => Promise<void>;

        await onSelect('copy-path', shortcut);

        expect(clipboardMock.writeText).toHaveBeenCalledWith(shortcut.path);

        unmount();
    });

    it('user gets the menu closed once an action is chosen', async () => {
        const { shortcut, result, unmount } = await mountWithResults();
        result.handleContextMenu(new MouseEvent('contextmenu', { clientX: 10, clientY: 10 }), 0);
        expect(result.isContextMenuOpen.value).toBe(true);

        const { useContextMenu } = await import('@composables/useContextMenu');
        const onSelect = (useContextMenu as unknown as ReturnType<typeof vi.fn>).mock
            .calls[0]![1] as (key: string, item: QuickShortcutItem) => Promise<void>;

        await onSelect('open-folder', shortcut);

        expect(result.isContextMenuOpen.value).toBe(false);

        unmount();
    });

    it('user is not interrupted when the file manager refuses to open the folder', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        revealItemInDirMock.mockRejectedValue(new Error('no shell'));
        const { shortcut, unmount } = await mountWithResults();

        const { useContextMenu } = await import('@composables/useContextMenu');
        const onSelect = (useContextMenu as unknown as ReturnType<typeof vi.fn>).mock
            .calls[0]![1] as (key: string, item: QuickShortcutItem) => Promise<void>;

        await expect(onSelect('open-folder', shortcut)).resolves.toBeUndefined();

        unmount();
    });

    it('user is not interrupted when the clipboard write fails', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        clipboardMock.writeText.mockRejectedValue(new Error('clipboard locked'));
        const { shortcut, unmount } = await mountWithResults();

        const { useContextMenu } = await import('@composables/useContextMenu');
        const onSelect = (useContextMenu as unknown as ReturnType<typeof vi.fn>).mock
            .calls[0]![1] as (key: string, item: QuickShortcutItem) => Promise<void>;

        await expect(onSelect('copy-path', shortcut)).resolves.toBeUndefined();

        unmount();
    });
});

describe('when the user opens the context menu from the keyboard', () => {
    it('user gets the menu anchored on the highlighted row', async () => {
        const { result, unmount } = await mountWithResults();
        const row = document.createElement('div');
        row.getBoundingClientRect = () =>
            ({ left: 10, top: 20, width: 100, height: 40 }) as DOMRect;
        result.itemRefs.value = [row];
        result.highlightedIndex.value = 0;

        result.openContextMenuForHighlightedItem();

        expect(contextMenuState.open).toHaveBeenCalledWith(
            expect.any(MouseEvent),
            expect.objectContaining({ name: 'TouchAI' })
        );
        const event = contextMenuState.open.mock.calls[0]![0] as MouseEvent;
        expect(event.clientX).toBe(60);
        expect(event.clientY).toBe(40);
        expect(result.isContextMenuOpen.value).toBe(true);

        unmount();
    });

    it('user gets no menu when nothing is highlighted', async () => {
        const { result, unmount } = await mountWithResults();
        result.highlightedIndex.value = -1;

        result.openContextMenuForHighlightedItem();

        expect(contextMenuState.open).not.toHaveBeenCalled();

        unmount();
    });

    it('user gets no menu when the highlighted row has no element yet', async () => {
        const { result, unmount } = await mountWithResults();
        result.itemRefs.value = [];
        result.highlightedIndex.value = 0;

        result.openContextMenuForItem(0);

        expect(contextMenuState.open).not.toHaveBeenCalled();
        expect(result.isContextMenuOpen.value).toBe(false);

        unmount();
    });
});

describe('when paging through more results fails or ends', () => {
    it('user keeps the results already on screen when the next page request fails', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const { result, unmount } = await mountWithResults({
            searchShortcuts: vi
                .fn()
                .mockResolvedValueOnce(
                    createSearchResult([createShortcut('App')], [createShortcut('File1')], {
                        total_results: 10,
                    })
                )
                .mockRejectedValueOnce(new Error('index gone')),
        });

        const before = result.results.value.length;
        await result.loadMore();
        await flushAsyncWork();

        expect(result.results.value.length).toBe(before);
        expect(result.isLoadingMore.value).toBe(false);

        unmount();
    });

    it('user gets no page append when the next page is empty', async () => {
        const { result, unmount } = await mountWithResults({
            searchShortcuts: vi
                .fn()
                .mockResolvedValueOnce(
                    createSearchResult([createShortcut('App')], [], { total_results: 10 })
                )
                .mockResolvedValueOnce(createSearchResult([], [], { total_results: 10 })),
        });

        const before = result.results.value.length;
        await result.loadMore();

        expect(result.results.value.length).toBe(before);

        unmount();
    });

    it('user gets only one page request while a page is already loading', async () => {
        let resolveSecondPage: ((value: QuickSearchResult) => void) | null = null;
        const searchShortcuts = vi
            .fn()
            .mockResolvedValueOnce(
                createSearchResult([createShortcut('App')], [], { total_results: 10 })
            )
            .mockImplementationOnce(
                () =>
                    new Promise<QuickSearchResult>((resolve) => {
                        resolveSecondPage = resolve;
                    })
            );

        const { result, deps, unmount } = await mountWithResults({ searchShortcuts });
        searchShortcuts.mockClear();

        const first = result.loadMore();
        const second = result.loadMore();
        resolveSecondPage!(
            createSearchResult([], [createShortcut('File2')], { total_results: 10 })
        );
        await Promise.all([first, second]);
        await flushAsyncWork();

        expect(searchShortcuts).toHaveBeenCalledTimes(1);
        expect(deps.searchShortcuts).toHaveBeenCalledTimes(1);

        unmount();
    });

    it('user gets the next page requested from the offset the backend reported', async () => {
        const searchShortcuts = vi
            .fn()
            .mockResolvedValueOnce(
                createSearchResult([createShortcut('App')], [createShortcut('File1')], {
                    total_results: 10,
                    next_offset: 42,
                })
            )
            .mockResolvedValueOnce(
                createSearchResult([], [createShortcut('File2')], {
                    total_results: 10,
                    next_offset: 84,
                })
            );

        const { result, unmount } = await mountWithResults({ searchShortcuts });

        await result.loadMore();

        expect(searchShortcuts).toHaveBeenLastCalledWith('touch', 60, 42);

        unmount();
    });
});

describe('when the quick search is searched again from the page', () => {
    it('user gets the query translated into a fresh search when the panel opens', async () => {
        const { result, deps, searchQuery, open, unmount } = await mountWithResults();
        deps.searchShortcuts.mockClear();

        await result.close();
        searchQuery.value = 'second';
        open.value = true;
        result.triggerSearch('second');
        await vi.advanceTimersByTimeAsync(80);
        await flushAsyncWork();

        expect(deps.searchShortcuts).toHaveBeenCalledWith('second', 60, 0);

        unmount();
    });

    it('user gets the pending debounce dropped when the panel closes', async () => {
        const { result, deps, searchQuery, unmount } = await mountWithResults();
        deps.searchShortcuts.mockClear();

        searchQuery.value = 'typing';
        result.triggerSearch('typing');
        // Closing before the debounce fires must not run the stale query.
        await result.close();
        await vi.advanceTimersByTimeAsync(200);
        await flushAsyncWork();

        expect(deps.searchShortcuts).not.toHaveBeenCalled();

        unmount();
    });
});

describe('when quick search is not available on this machine', () => {
    it('user gets no search started while the feature is disabled', async () => {
        const enabled = ref(false);
        const deps = createDeps();
        const open = ref(false);
        const searchQuery = ref('touch');
        const mounted = await mountComposable(() =>
            useQuickSearchLogic(
                { open, searchQuery, enabled, emitOpenUpdate: (value) => (open.value = value) },
                deps
            )
        );

        mounted.result.triggerSearch('touch');
        await vi.advanceTimersByTimeAsync(200);

        expect(deps.searchShortcuts).not.toHaveBeenCalled();
        expect(open.value).toBe(false);

        mounted.unmount();
    });

    it('user gets the panel closed when the feature becomes unavailable while open', async () => {
        const { result, open, enabled, unmount } = await mountWithResults();
        expect(open.value).toBe(true);

        enabled.value = false;
        await nextTick();
        await flushAsyncWork();

        expect(open.value).toBe(false);
        expect(result.results.value).toEqual([]);

        unmount();
    });

    it('user gets the index warmed as soon as the panel mounts so the first search is fast', async () => {
        const deps = createDeps();
        const open = ref(false);
        const searchQuery = ref('');

        const mounted = await mountComposable(() =>
            useQuickSearchLogic(
                { open, searchQuery, enabled: ref(true), emitOpenUpdate: (v) => (open.value = v) },
                deps
            )
        );
        await flushAsyncWork();

        expect(deps.quickSearch.prepareIndex).toHaveBeenCalledWith(false);
        expect(deps.quickSearch.getStatus).toHaveBeenCalled();

        mounted.unmount();
    });
});

describe('when the user scrolls the result grid', () => {
    it('user gets the next page loaded when the scroll reaches the bottom', async () => {
        const searchShortcuts = vi
            .fn()
            .mockResolvedValueOnce(
                createSearchResult([createShortcut('App')], [createShortcut('File1')], {
                    total_results: 10,
                })
            )
            .mockResolvedValueOnce(
                createSearchResult([], [createShortcut('File2')], { total_results: 10 })
            );
        const { result, unmount } = await mountWithResults({ searchShortcuts });

        const scrollHost = document.createElement('div');
        let scrollTop = 900;
        Object.defineProperty(scrollHost, 'scrollTop', {
            configurable: true,
            get: () => scrollTop,
            set: (value: number) => {
                scrollTop = value;
            },
        });
        Object.defineProperty(scrollHost, 'clientHeight', { configurable: true, value: 300 });
        Object.defineProperty(scrollHost, 'scrollHeight', { configurable: true, value: 1200 });
        result.scrollRef.value = scrollHost;

        result.handleScroll();
        await flushAsyncWork();
        await nextTick();

        expect(searchShortcuts).toHaveBeenCalledTimes(2);
        expect(result.results.value.map((item) => item.name)).toContain('File2');
        // The user's scroll position is kept while the next page is appended.
        expect(scrollTop).toBe(900);

        unmount();
    });

    it('user gets no extra page requested when the scroll is still above the bottom', async () => {
        const searchShortcuts = vi.fn().mockResolvedValue(
            createSearchResult([createShortcut('App')], [createShortcut('File1')], {
                total_results: 10,
            })
        );
        const { result, unmount } = await mountWithResults({ searchShortcuts });
        searchShortcuts.mockClear();

        const scrollHost = document.createElement('div');
        Object.defineProperty(scrollHost, 'scrollTop', { configurable: true, value: 100 });
        Object.defineProperty(scrollHost, 'clientHeight', { configurable: true, value: 300 });
        Object.defineProperty(scrollHost, 'scrollHeight', { configurable: true, value: 1200 });
        result.scrollRef.value = scrollHost;

        result.handleScroll();
        await flushAsyncWork();

        // Scrolling through the results the user already has must not page the backend.
        expect(searchShortcuts).not.toHaveBeenCalled();

        unmount();
    });
});
