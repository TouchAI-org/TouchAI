import type { QuickShortcutItem } from '@services/NativeService';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

import {
    useAssetLoader,
    type UseAssetLoaderDeps,
} from '@/views/SearchView/components/QuickSearchPanel/composables/useAssetLoader';

/**
 * Branch pass over the quick-search asset loader: the list view geometry, the
 * missing-scroll-container fallbacks, the retry ceilings, the pending/re-entrancy
 * gates and the cache pruning thresholds. The native asset lookups are the process
 * boundary; every assertion is about which paths get requested or which map the
 * panel ends up showing.
 */
vi.mock('@services/NativeService', () => ({
    native: {
        quickSearch: {
            getImageThumbnails: vi.fn(),
            getShortcutIcons: vi.fn(),
        },
    },
}));

function createItem(
    name: string,
    path: string,
    source: QuickShortcutItem['source'] = 'desktop_user'
): QuickShortcutItem {
    return { name, path, source };
}

function createAssetMap(paths: string[], prefix: string) {
    return Object.fromEntries(paths.map((path) => [path, `${prefix}:${path}`]));
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

async function flushAsyncWork() {
    for (let index = 0; index < 4; index += 1) {
        await Promise.resolve();
    }
}

/** The deps are typed as the real native functions, so read the mock surface explicitly. */
function mockCalls(fn: unknown): unknown[][] {
    return (fn as { mock: { calls: unknown[][] } }).mock.calls;
}

function createLoaderContext(
    options: {
        items?: QuickShortcutItem[];
        requestId?: number;
        isOpen?: boolean;
        searchInFlight?: boolean;
        pendingQuery?: string | null;
        gridColumns?: number;
        gridGap?: number;
        selectionMaxHeight?: number;
        viewMode?: 'grid' | 'list';
        scrollTop?: number;
        clientHeight?: number;
        noScrollContainer?: boolean;
        deps?: Partial<UseAssetLoaderDeps>;
    } = {}
) {
    const getImageThumbnails = vi.fn(async (paths: string[]) => createAssetMap(paths, 'preview'));
    const getShortcutIcons = vi.fn(async (paths: string[]) => createAssetMap(paths, 'icon'));
    const deps: UseAssetLoaderDeps = {
        getImageThumbnails,
        getShortcutIcons,
        ...options.deps,
    };

    const isOpen = ref(options.isOpen ?? true);
    const results = ref(options.items ?? []);
    const requestId = ref(options.requestId ?? 1);
    const searchInFlight = ref(options.searchInFlight ?? false);
    const pendingQuery = ref<string | null>(options.pendingQuery ?? null);
    const gridColumns = ref(options.gridColumns ?? 2);
    const gridGap = ref(options.gridGap ?? 8);
    const selectionMaxHeight = ref(options.selectionMaxHeight ?? 32);
    const viewMode = ref<'grid' | 'list'>(options.viewMode ?? 'grid');
    const scrollRef = ref<HTMLElement | null>(null);

    if (!options.noScrollContainer) {
        const container = document.createElement('div');
        container.scrollTop = options.scrollTop ?? 0;
        Object.defineProperty(container, 'clientHeight', {
            configurable: true,
            value: options.clientHeight ?? 32,
        });
        scrollRef.value = container;
    }

    return {
        loader: useAssetLoader(
            {
                isOpen,
                results,
                requestId,
                searchInFlight,
                pendingQuery,
                gridColumns,
                gridGap,
                selectionMaxHeight,
                scrollRef,
                viewMode,
            },
            deps
        ),
        deps,
        isOpen,
        results,
        requestId,
        searchInFlight,
        pendingQuery,
        gridColumns,
        gridGap,
        selectionMaxHeight,
        scrollRef,
        viewMode,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
});

describe('when the panel shows results as a list', () => {
    it('user gets a later starting row than the grid layout would use for the same scroll', async () => {
        // List rows are 40px, grid tiles 88px: at 400px scrolled the list is already
        // past row 9 while the grid is still around row 4.
        const items = Array.from({ length: 40 }, (_, index) =>
            createItem(`Item ${index}`, `D:/list/item-${index}.lnk`)
        );
        const context = createLoaderContext({
            items,
            viewMode: 'list',
            gridColumns: 1,
            gridGap: 8,
            scrollTop: 400,
            clientHeight: 32,
        });

        context.loader.scheduleIconLoad(context.requestId.value, true);
        await vi.advanceTimersByTimeAsync(0);
        await flushAsyncWork();

        // A batch holds at most 4 icons, and the first one is from the list viewport.
        const requested = mockCalls(context.deps.getShortcutIcons)[0]![0] as string[];
        expect(requested).toHaveLength(4);
        expect(requested[0]).toBe('D:/list/item-9.lnk');

        context.loader.resetLoadingState();
    });

    it('user gets an earlier starting row in the grid layout at the same scroll', async () => {
        const items = Array.from({ length: 40 }, (_, index) =>
            createItem(`Item ${index}`, `D:/grid/item-${index}.lnk`)
        );
        const context = createLoaderContext({
            items,
            viewMode: 'grid',
            gridColumns: 1,
            gridGap: 8,
            scrollTop: 400,
            clientHeight: 32,
        });

        context.loader.scheduleIconLoad(context.requestId.value, true);
        await vi.advanceTimersByTimeAsync(0);
        await flushAsyncWork();

        // Taller grid tiles mean fewer rows are behind the same scroll offset.
        const requested = mockCalls(context.deps.getShortcutIcons)[0]![0] as string[];
        expect(requested[0]).toBe('D:/grid/item-3.lnk');

        context.loader.resetLoadingState();
    });
});

describe('when the scroll container is not mounted yet', () => {
    it('user still gets the first items preloaded from the top of the list', async () => {
        const items = Array.from({ length: 6 }, (_, index) =>
            createItem(`Item ${index}`, `D:/noscroll/item-${index}.lnk`)
        );
        const context = createLoaderContext({
            items,
            noScrollContainer: true,
            selectionMaxHeight: 32,
        });

        context.loader.scheduleIconLoad(context.requestId.value, true);
        await vi.advanceTimersByTimeAsync(0);
        await flushAsyncWork();

        // Without a scroll container the loader falls back to the top of the list.
        expect(context.deps.getShortcutIcons).toHaveBeenCalled();
        const requested = mockCalls(context.deps.getShortcutIcons)[0]![0] as string[];
        expect(requested).toContain('D:/noscroll/item-0.lnk');

        context.loader.resetLoadingState();
    });
});

describe('when the result list is empty', () => {
    it('user gets no asset lookups at all', async () => {
        const context = createLoaderContext({ items: [] });

        context.loader.scheduleIconLoad(context.requestId.value, true);
        context.loader.scheduleImageLoad(context.requestId.value, true);
        await vi.advanceTimersByTimeAsync(200);
        await flushAsyncWork();

        expect(context.deps.getShortcutIcons).not.toHaveBeenCalled();
        expect(context.deps.getImageThumbnails).not.toHaveBeenCalled();
    });
});

describe('when a lookup keeps returning nothing', () => {
    it('user gets no extra request when the batch comes back empty', async () => {
        const context = createLoaderContext({
            items: [createItem('Doc', 'D:/docs/empty.txt', 'file')],
            deps: {
                getShortcutIcons: vi.fn().mockResolvedValue({}),
            },
        });

        context.loader.scheduleIconLoad(context.requestId.value, true);
        await vi.advanceTimersByTimeAsync(0);
        await flushAsyncWork();

        // An empty batch still counts as an attempt, so no endless re-queue follows.
        expect(context.deps.getShortcutIcons).toHaveBeenCalledTimes(1);
        expect(context.loader.iconMap.value).toEqual({});

        context.loader.resetLoadingState();
    });
});

describe('when the panel closes mid-load', () => {
    it('user gets no icons written after the panel was closed', async () => {
        const batch = deferred<Record<string, string>>();
        const context = createLoaderContext({
            items: [createItem('Doc', 'D:/docs/late.txt', 'file')],
            deps: { getShortcutIcons: vi.fn(() => batch.promise) },
        });

        context.loader.scheduleIconLoad(context.requestId.value, true);
        await vi.advanceTimersByTimeAsync(0);

        context.isOpen.value = false;
        batch.resolve({ 'D:/docs/late.txt': 'icon:D:/docs/late.txt' });
        await flushAsyncWork();

        expect(context.loader.iconMap.value).toEqual({});

        context.loader.resetLoadingState();
    });

    it('user gets no scroll work scheduled while the panel is closed', async () => {
        const context = createLoaderContext({
            items: [createItem('Doc', 'D:/docs/x.txt', 'file')],
            isOpen: false,
        });

        context.loader.handleScroll();
        await vi.advanceTimersByTimeAsync(200);
        await flushAsyncWork();

        expect(context.deps.getShortcutIcons).not.toHaveBeenCalled();
        expect(context.deps.getImageThumbnails).not.toHaveBeenCalled();
    });

    it('user gets a scroll restart that lands after closing ignored', async () => {
        const context = createLoaderContext({
            items: [createItem('Doc', 'D:/docs/y.txt', 'file')],
        });

        context.loader.handleScroll();
        context.isOpen.value = false;
        await vi.advanceTimersByTimeAsync(200);
        await flushAsyncWork();

        expect(context.deps.getShortcutIcons).not.toHaveBeenCalled();
    });
});

describe('when the user scrolls while a search is still running', () => {
    it('user gets the asset work deferred until the search settles', async () => {
        const context = createLoaderContext({
            items: [createItem('Doc', 'D:/docs/deferred.txt', 'file')],
            searchInFlight: true,
        });

        context.loader.scheduleIconLoad(context.requestId.value, true);
        await vi.advanceTimersByTimeAsync(200);
        expect(context.deps.getShortcutIcons).not.toHaveBeenCalled();

        context.searchInFlight.value = false;
        context.loader.flushPendingLoads();
        await vi.advanceTimersByTimeAsync(400);
        await flushAsyncWork();

        expect(context.deps.getShortcutIcons).toHaveBeenCalled();

        context.loader.resetLoadingState();
    });

    it('user gets the deferred work dropped when the panel closes first', async () => {
        const context = createLoaderContext({
            items: [createItem('Doc', 'D:/docs/gone.txt', 'file')],
            searchInFlight: true,
        });

        context.loader.scheduleIconLoad(context.requestId.value, true);
        context.isOpen.value = false;
        context.loader.flushPendingLoads();
        await vi.advanceTimersByTimeAsync(400);
        await flushAsyncWork();

        expect(context.deps.getShortcutIcons).not.toHaveBeenCalled();
    });
});

describe('when a pending query is queued', () => {
    it('user gets the asset work deferred instead of firing for a stale query', async () => {
        const context = createLoaderContext({
            items: [createItem('Doc', 'D:/docs/pending.txt', 'file')],
            pendingQuery: 'typing',
        });

        context.loader.scheduleIconLoad(context.requestId.value, true);
        await vi.advanceTimersByTimeAsync(200);

        expect(context.deps.getShortcutIcons).not.toHaveBeenCalled();

        context.pendingQuery.value = null;
        context.loader.flushPendingLoads();
        await vi.advanceTimersByTimeAsync(400);
        await flushAsyncWork();

        expect(context.deps.getShortcutIcons).toHaveBeenCalled();

        context.loader.resetLoadingState();
    });
});

describe('when a second batch is requested while one is in flight', () => {
    it('user gets the second batch queued rather than dropped', async () => {
        const first = deferred<Record<string, string>>();
        const items = [
            createItem('A', 'D:/multi/a.lnk'),
            createItem('B', 'D:/multi/b.lnk'),
            createItem('C', 'D:/multi/c.lnk'),
        ];
        const getShortcutIcons = vi
            .fn()
            .mockImplementationOnce(() => first.promise)
            .mockImplementation(async (paths: string[]) => createAssetMap(paths, 'icon'));
        const context = createLoaderContext({ items, gridColumns: 1, deps: { getShortcutIcons } });

        context.loader.scheduleIconLoad(context.requestId.value, true);
        await vi.advanceTimersByTimeAsync(0);
        expect(getShortcutIcons).toHaveBeenCalledTimes(1);

        // Asking again while the first batch is running must not start a parallel call.
        context.loader.scheduleIconLoad(context.requestId.value, true);
        expect(getShortcutIcons).toHaveBeenCalledTimes(1);

        first.resolve(createAssetMap(['D:/multi/a.lnk'], 'icon'));
        await flushAsyncWork();
        await vi.advanceTimersByTimeAsync(0);
        await flushAsyncWork();

        expect(getShortcutIcons.mock.calls.length).toBeGreaterThan(1);

        context.loader.resetLoadingState();
    });
});

describe('when the cached maps grow past the pruning threshold', () => {
    it('user gets the maps left alone while they are still small', () => {
        const context = createLoaderContext({
            items: [createItem('Keep', 'D:/small/keep.lnk')],
        });
        context.loader.iconMap.value = {
            'D:/small/keep.lnk': 'icon:keep',
            'D:/small/stale.lnk': 'icon:stale',
        };

        // Without force and under the limit, pruning is skipped entirely.
        context.loader.pruneIconMaps();

        expect(context.loader.iconMap.value).toEqual({
            'D:/small/keep.lnk': 'icon:keep',
            'D:/small/stale.lnk': 'icon:stale',
        });
    });

    it('user gets stale entries dropped once the maps grow large', () => {
        const context = createLoaderContext({
            items: [createItem('Keep', 'D:/large/keep.lnk')],
        });
        const big: Record<string, string> = { 'D:/large/keep.lnk': 'icon:keep' };
        // The threshold is 60 * 6 = 360 entries, so cross it deliberately.
        for (let index = 0; index < 400; index += 1) {
            big[`D:/large/stale-${index}.lnk`] = `icon:stale-${index}`;
        }
        context.loader.iconMap.value = { ...big };

        // Crossing the limit prunes without an explicit force flag.
        context.loader.pruneIconMaps();

        expect(Object.keys(context.loader.iconMap.value)).toEqual(['D:/large/keep.lnk']);
    });
});

describe('when the user hovers a result', () => {
    it('user gets the full path as the tooltip for a file result', () => {
        const context = createLoaderContext();

        expect(context.loader.getItemHoverTitle(createItem('f', 'D:/a/b.txt', 'file'))).toBe(
            'D:/a/b.txt'
        );
    });

    it('user gets the full path as the tooltip for a shortcut-file result', () => {
        const context = createLoaderContext();

        expect(
            context.loader.getItemHoverTitle(createItem('f', 'D:/a/c.txt', 'shortcut_file'))
        ).toBe('D:/a/c.txt');
    });

    it('user gets no tooltip for an app shortcut', () => {
        const context = createLoaderContext();

        // An application entry has no meaningful path to show.
        expect(context.loader.getItemHoverTitle(createItem('s', 'D:/a/app.lnk'))).toBe('');
    });
});

describe('when the user hovers an image result', () => {
    it('user gets image treatment only for local image files', () => {
        const context = createLoaderContext();

        expect(context.loader.isImageItem(createItem('i', 'D:/pics/a.png', 'file'))).toBe(true);
        expect(context.loader.isImageItem(createItem('i', 'D:/pics/a.txt', 'file'))).toBe(false);
        // A shortcut pointing at an image is still an app entry, not a preview.
        expect(context.loader.isImageItem(createItem('i', 'D:/pics/a.png'))).toBe(false);
    });
});

describe('when the image retry ceiling is reached', () => {
    it('user gets no further thumbnail attempts for that image', async () => {
        const getImageThumbnails = vi.fn().mockRejectedValue(new Error('thumbnail failed'));
        const context = createLoaderContext({
            items: [createItem('Pic', 'D:/images/capped.png', 'file')],
            gridColumns: 1,
            deps: { getImageThumbnails },
        });
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        for (let attempt = 0; attempt < 4; attempt += 1) {
            context.loader.scheduleImageLoad(context.requestId.value, true);
            await vi.advanceTimersByTimeAsync(0);
            await flushAsyncWork();
        }

        // The attempt ceiling stops the retry loop instead of hammering the backend.
        expect(getImageThumbnails.mock.calls.length).toBeLessThanOrEqual(3);

        context.loader.resetLoadingState();
    });
});

describe('when the loader is reset', () => {
    it('user gets every cached map and pending timer cleared', async () => {
        const context = createLoaderContext({
            items: [createItem('A', 'D:/reset/a.lnk')],
        });

        context.loader.scheduleIconLoad(context.requestId.value, false);
        context.loader.handleScroll();
        context.loader.resetLoadingState();
        await vi.advanceTimersByTimeAsync(400);
        await flushAsyncWork();

        expect(context.deps.getShortcutIcons).not.toHaveBeenCalled();
        expect(context.loader.iconMap.value).toEqual({});
        expect(context.loader.imagePreviewMap.value).toEqual({});
    });
});
