import type { QuickShortcutItem } from '@services/NativeService';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

import {
    useAssetLoader,
    type UseAssetLoaderDeps,
} from '@/views/SearchView/components/QuickSearchPanel/composables/useAssetLoader';

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
    return {
        name,
        path,
        source,
    };
}

function createScrollContainer(
    options: {
        scrollTop?: number;
        clientHeight?: number;
    } = {}
) {
    const { scrollTop = 0, clientHeight = 32 } = options;
    const container = document.createElement('div');
    container.scrollTop = scrollTop;
    Object.defineProperty(container, 'clientHeight', {
        configurable: true,
        value: clientHeight,
    });
    return container;
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

    return {
        promise,
        resolve,
        reject,
    };
}

async function flushAsyncWork() {
    await Promise.resolve();
    await Promise.resolve();
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
        scrollTop?: number;
        clientHeight?: number;
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
    const scrollRef = ref<HTMLElement | null>(
        createScrollContainer({
            scrollTop: options.scrollTop,
            clientHeight: options.clientHeight,
        })
    );

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
    };
}

describe('useAssetLoader', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    it('prioritizes shortcut icons before file icons in the current viewport', async () => {
        const items = [
            createItem('Top File', 'D:/top/file-1.txt', 'file'),
            createItem('Top Shortcut', 'D:/top/shortcut-1.lnk'),
            createItem('Top Image', 'D:/top/image-1.png', 'file'),
            createItem('Top Shortcut 2', 'D:/top/shortcut-2.lnk'),
            createItem('Visible File', 'D:/visible/file-1.txt', 'file'),
            createItem('Visible Shortcut', 'D:/visible/shortcut-1.lnk'),
            createItem('Visible Image', 'D:/visible/image-1.png', 'file'),
            createItem('Visible Shortcut 2', 'D:/visible/shortcut-2.lnk', 'desktop_public'),
            createItem('Visible File 2', 'D:/visible/file-2.txt', 'file'),
        ];
        const context = createLoaderContext({
            items,
            gridColumns: 2,
            scrollTop: 96 * 3,
            clientHeight: 20,
            selectionMaxHeight: 20,
        });

        context.loader.scheduleIconLoad(context.requestId.value, true);
        await vi.advanceTimersByTimeAsync(0);
        await flushAsyncWork();

        expect(context.deps.getShortcutIcons).toHaveBeenCalledTimes(1);
        expect(context.deps.getShortcutIcons).toHaveBeenCalledWith(
            [
                'D:/visible/shortcut-1.lnk',
                'D:/visible/shortcut-2.lnk',
                'D:/visible/file-1.txt',
                'D:/visible/file-2.txt',
            ],
            48
        );
        expect(context.loader.iconMap.value).toEqual({
            'D:/visible/shortcut-1.lnk': 'icon:D:/visible/shortcut-1.lnk',
            'D:/visible/shortcut-2.lnk': 'icon:D:/visible/shortcut-2.lnk',
            'D:/visible/file-1.txt': 'icon:D:/visible/file-1.txt',
            'D:/visible/file-2.txt': 'icon:D:/visible/file-2.txt',
        });
    });

    it('replays pending image loads after the search settles and continues remaining batches', async () => {
        const firstBatch = deferred<Record<string, string>>();
        const context = createLoaderContext({
            items: [
                createItem('Image 1', 'D:/images/one.png', 'file'),
                createItem('Image 2', 'D:/images/two.png', 'file'),
                createItem('Image 3', 'D:/images/three.png', 'file'),
            ],
            gridColumns: 1,
            searchInFlight: true,
            deps: {
                getImageThumbnails: vi
                    .fn()
                    .mockImplementationOnce(() => firstBatch.promise)
                    .mockImplementationOnce(async (paths: string[]) =>
                        createAssetMap(paths, 'preview')
                    ),
            },
        });

        context.loader.scheduleImageLoad(context.requestId.value, true);
        await vi.advanceTimersByTimeAsync(200);
        expect(context.deps.getImageThumbnails).not.toHaveBeenCalled();

        context.searchInFlight.value = false;
        context.loader.flushPendingLoads();
        await vi.advanceTimersByTimeAsync(120);

        expect(context.deps.getImageThumbnails).toHaveBeenCalledTimes(1);
        expect(context.deps.getImageThumbnails).toHaveBeenNthCalledWith(
            1,
            ['D:/images/one.png', 'D:/images/two.png'],
            56
        );

        firstBatch.resolve({
            'D:/images/one.png': 'preview:D:/images/one.png',
            'D:/images/two.png': 'preview:D:/images/two.png',
        });
        await flushAsyncWork();
        await vi.advanceTimersByTimeAsync(0);
        await flushAsyncWork();

        expect(context.deps.getImageThumbnails).toHaveBeenCalledTimes(2);
        expect(context.deps.getImageThumbnails).toHaveBeenNthCalledWith(
            2,
            ['D:/images/three.png'],
            56
        );
        expect(context.loader.imagePreviewMap.value).toEqual({
            'D:/images/one.png': 'preview:D:/images/one.png',
            'D:/images/two.png': 'preview:D:/images/two.png',
            'D:/images/three.png': 'preview:D:/images/three.png',
        });
    });

    it('does not merge stale icon batches after a newer request supersedes the current one', async () => {
        const iconBatch = deferred<Record<string, string>>();
        const context = createLoaderContext({
            items: [createItem('Doc', 'D:/docs/report.txt', 'file')],
            deps: {
                getShortcutIcons: vi.fn(() => iconBatch.promise),
            },
        });

        context.loader.scheduleIconLoad(context.requestId.value, true);
        await vi.advanceTimersByTimeAsync(0);

        context.requestId.value = 2;
        iconBatch.resolve({
            'D:/docs/report.txt': 'icon:D:/docs/report.txt',
        });
        await flushAsyncWork();

        expect(context.deps.getShortcutIcons).toHaveBeenCalledTimes(1);
        expect(context.loader.iconMap.value).toEqual({});
    });

    it('prunes stale cached icons and previews while keeping assets for current results', () => {
        const context = createLoaderContext({
            items: [
                createItem('Current Icon', 'D:/keep/icon.lnk'),
                createItem('Current Image', 'D:/keep/image.png', 'file'),
            ],
        });

        context.loader.iconMap.value = {
            'D:/keep/icon.lnk': 'icon:D:/keep/icon.lnk',
            'D:/stale/icon.lnk': 'icon:D:/stale/icon.lnk',
        };
        context.loader.imagePreviewMap.value = {
            'D:/keep/image.png': 'preview:D:/keep/image.png',
            'D:/stale/image.png': 'preview:D:/stale/image.png',
        };

        context.loader.pruneIconMaps(true);

        expect(context.loader.iconMap.value).toEqual({
            'D:/keep/icon.lnk': 'icon:D:/keep/icon.lnk',
        });
        expect(context.loader.imagePreviewMap.value).toEqual({
            'D:/keep/image.png': 'preview:D:/keep/image.png',
        });
    });

    it('caps repeated icon retries and allows a clean retry after resetLoadingState', async () => {
        const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const context = createLoaderContext({
            items: [createItem('Retry Me', 'D:/retry/me.txt', 'file')],
            deps: {
                getShortcutIcons: vi.fn().mockRejectedValue(new Error('icon lookup failed')),
            },
        });

        context.loader.scheduleIconLoad(context.requestId.value, true);
        await vi.advanceTimersByTimeAsync(0);
        await flushAsyncWork();

        context.loader.scheduleIconLoad(context.requestId.value, true);
        await vi.advanceTimersByTimeAsync(0);
        await flushAsyncWork();

        context.loader.scheduleIconLoad(context.requestId.value, true);
        await vi.advanceTimersByTimeAsync(0);
        await flushAsyncWork();

        expect(context.deps.getShortcutIcons).toHaveBeenCalledTimes(2);
        expect(consoleWarnSpy).toHaveBeenCalledTimes(2);

        context.loader.resetLoadingState();
        context.loader.scheduleIconLoad(context.requestId.value, true);
        await vi.advanceTimersByTimeAsync(0);
        await flushAsyncWork();

        expect(context.deps.getShortcutIcons).toHaveBeenCalledTimes(3);
    });

    it('cancels queued timers when the loader state is reset before a delayed run fires', async () => {
        const context = createLoaderContext({
            items: [createItem('Delayed', 'D:/delayed/shortcut.lnk')],
        });

        context.loader.scheduleIconLoad(context.requestId.value, false);
        context.loader.scheduleImageLoad(context.requestId.value, false);
        context.loader.resetLoadingState();

        await vi.advanceTimersByTimeAsync(300);
        await flushAsyncWork();

        expect(context.deps.getShortcutIcons).not.toHaveBeenCalled();
        expect(context.deps.getImageThumbnails).not.toHaveBeenCalled();
    });
});
