import type { QuickShortcutItem } from '@services/NativeService';
import { log } from '@services/ObservabilityService';
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

class ResizeObserverMock {
    static instances: ResizeObserverMock[] = [];

    readonly observed: Element[] = [];
    disconnected = false;

    constructor(private readonly callback: ResizeObserverCallback) {
        ResizeObserverMock.instances.push(this);
    }

    observe(element: Element) {
        this.observed.push(element);
    }

    disconnect() {
        this.disconnected = true;
    }

    emit(element = this.observed[0]) {
        if (!element) throw new Error('No observed viewport');
        this.callback(
            [{ target: element } as unknown as ResizeObserverEntry],
            this as unknown as ResizeObserver
        );
    }
}

function setClientHeight(container: HTMLElement, clientHeight: number) {
    Object.defineProperty(container, 'clientHeight', {
        configurable: true,
        value: clientHeight,
    });
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
        viewMode?: 'grid' | 'list';
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
    const viewMode = ref<'grid' | 'list'>(options.viewMode ?? 'grid');
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
    };
}

describe('when the quick search panel loads icons and previews', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        ResizeObserverMock.instances = [];
        vi.stubGlobal('ResizeObserver', ResizeObserverMock);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        document.body.innerHTML = '';
    });

    it('user gets icons immediately after the current search settles', async () => {
        const context = createLoaderContext({
            items: [createItem('Report', 'D:/docs/report.txt', 'file')],
            searchInFlight: true,
        });
        context.loader.scheduleIconLoad();
        expect(context.loader.iconMap.value).toEqual({});

        context.searchInFlight.value = false;
        context.loader.flushPendingLoads();
        await vi.advanceTimersByTimeAsync(0);
        await flushAsyncWork();

        expect(context.loader.iconMap.value['D:/docs/report.txt']).toBe('icon:D:/docs/report.txt');
        context.loader.resetLoadingState();
    });

    it('user sees both visible grid rows when the first icon request finishes', async () => {
        const ready = deferred<void>();
        const items = Array.from({ length: 14 }, (_, index) =>
            createItem(`App ${index}`, `D:/apps/app-${index}.lnk`)
        );
        const context = createLoaderContext({
            items,
            gridColumns: 7,
            clientHeight: 200,
            deps: {
                getShortcutIcons: async (paths) => {
                    await ready.promise;
                    return createAssetMap(paths, 'icon');
                },
            },
        });
        context.loader.scheduleIconLoad(context.requestId.value, true);
        await vi.advanceTimersByTimeAsync(0);
        ready.resolve();
        await flushAsyncWork();

        expect(context.loader.iconMap.value).toEqual(
            createAssetMap(
                items.map((item) => item.path),
                'icon'
            )
        );
        context.loader.resetLoadingState();
    });

    it('user sees newly revealed rows load when the rendered viewport grows', async () => {
        const items = Array.from({ length: 36 }, (_, index) =>
            createItem(`File ${index + 1}`, `D:/files/file-${index + 1}.md`, 'file')
        );
        const context = createLoaderContext({
            items,
            gridColumns: 7,
            clientHeight: 96,
        });

        context.loader.scheduleIconLoad(context.requestId.value, true);
        await vi.advanceTimersByTimeAsync(0);
        await flushAsyncWork();

        expect(context.loader.iconMap.value).toEqual(
            createAssetMap(
                items.slice(0, 21).map((item) => item.path),
                'icon'
            )
        );

        setClientHeight(context.scrollRef.value!, 392);
        ResizeObserverMock.instances[ResizeObserverMock.instances.length - 1]!.emit(
            context.scrollRef.value!
        );
        await vi.advanceTimersByTimeAsync(0);
        await flushAsyncWork();

        expect(context.loader.iconMap.value).toEqual(
            createAssetMap(
                items.map((item) => item.path),
                'icon'
            )
        );
    });

    it('user gets the icons of the visible rows requested, shortcuts first', async () => {
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
        const requested = vi.mocked(context.deps.getShortcutIcons).mock.calls[0]![0];
        expect(requested.slice(0, 4)).toEqual([
            'D:/visible/shortcut-1.lnk',
            'D:/visible/shortcut-2.lnk',
            'D:/visible/file-1.txt',
            'D:/visible/file-2.txt',
        ]);
        expect(requested.some((path) => path.endsWith('.png'))).toBe(false);
        expect(context.loader.iconMap.value).toMatchObject({
            'D:/visible/shortcut-1.lnk': 'icon:D:/visible/shortcut-1.lnk',
            'D:/visible/shortcut-2.lnk': 'icon:D:/visible/shortcut-2.lnk',
            'D:/visible/file-1.txt': 'icon:D:/visible/file-1.txt',
            'D:/visible/file-2.txt': 'icon:D:/visible/file-2.txt',
        });
    });

    it('user gets thumbnails only after the search settles, in batches of two', async () => {
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

    it('user never sees icons from a superseded search', async () => {
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

    it('user sees cached icons and previews dropped for results that are gone', () => {
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

    it('user does not get endless icon retries after a lookup keeps failing', async () => {
        const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
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
        expect(warnSpy).toHaveBeenCalledTimes(2);

        context.loader.resetLoadingState();
        context.loader.scheduleIconLoad(context.requestId.value, true);
        await vi.advanceTimersByTimeAsync(0);
        await flushAsyncWork();

        expect(context.deps.getShortcutIcons).toHaveBeenCalledTimes(3);
    });

    it('user gets no icon work for a search that was reset before it started', async () => {
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
