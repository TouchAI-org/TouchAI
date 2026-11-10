import { mountComposable } from '@tests/utils/composables';
import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

import type { QuickSearchResult } from '@/services/NativeService';
import {
    SearchActionDispatcher,
    type SearchActivationContext,
    SearchProviderRegistry,
} from '@/services/SearchService';
import { useQuickSearchLogic } from '@/views/SearchView/components/QuickSearchPanel/composables/useQuickSearchLogic';

afterEach(() => {
    vi.useRealTimers();
});

describe('given files and a trusted non-file contribution in the same search panel', () => {
    it.each([false, true])(
        'user given a slow search with reference mode %s when the same query is requested again then still receives its results',
        async (reference) => {
            vi.useFakeTimers();
            let finish!: (page: QuickSearchResult) => void;
            const pending = new Promise<QuickSearchResult>((resolve) => (finish = resolve));
            const open = ref(false);
            const mounted = await mountComposable(() =>
                useQuickSearchLogic(
                    {
                        open,
                        searchQuery: ref('report'),
                        referenceMode: ref(reference),
                        enabled: ref(true),
                        emitOpenUpdate: (value) => {
                            open.value = value;
                        },
                    },
                    {
                        openPath: async () => {},
                        window: { hideSearchWindow: async () => {} },
                        quickSearch: {
                            getStatus: async () => ({
                                provider: 'everything',
                                db_loaded: true,
                                index_warmed: true,
                                last_refresh_ms: null,
                                last_error: null,
                            }),
                            prepareIndex: async () => {},
                            searchShortcuts: () => pending,
                        },
                    }
                )
            );
            try {
                if (!reference) {
                    mounted.result.triggerSearch('report');
                    await vi.advanceTimersByTimeAsync(80);
                }
                mounted.result.triggerSearch('report');
                await vi.advanceTimersByTimeAsync(80);
                finish({
                    shortcuts: [],
                    files: [{ name: 'report.md', path: 'D:/report.md', source: 'file' }],
                    total_files: 1,
                    total_results: 1,
                    next_offset: 1,
                });
                await flushPromises();
                expect(open.value).toBe(true);
                expect(mounted.result.items.value.map(({ result }) => result.label)).toEqual([
                    'report.md',
                ]);
                expect(mounted.result.searchState.value).toBe('ready');
            } finally {
                mounted.unmount();
            }
        }
    );

    it('user switches a pending launcher query to a reference with the same keyword and receives only a reference action', async () => {
        vi.useFakeTimers();
        let finish!: (page: QuickSearchResult) => void;
        const pending = new Promise<QuickSearchResult>((resolve) => (finish = resolve));
        const page: QuickSearchResult = {
            shortcuts: [],
            files: [{ name: 'report.md', path: 'D:/report.md', source: 'file' }],
            total_files: 1,
            total_results: 1,
            next_offset: 1,
        };
        const open = ref(false);
        const referenceMode = ref(false);
        let firstRequest = true;
        const mounted = await mountComposable(() =>
            useQuickSearchLogic(
                {
                    open,
                    searchQuery: ref('report'),
                    referenceMode,
                    enabled: ref(true),
                    emitOpenUpdate: (value) => {
                        open.value = value;
                    },
                },
                {
                    openPath: async () => {},
                    window: { hideSearchWindow: async () => {} },
                    quickSearch: {
                        getStatus: async () => ({
                            provider: 'everything',
                            db_loaded: true,
                            index_warmed: true,
                            last_refresh_ms: null,
                            last_error: null,
                        }),
                        prepareIndex: async () => {},
                        searchShortcuts: () => {
                            if (firstRequest) {
                                firstRequest = false;
                                return pending;
                            }
                            return Promise.resolve(page);
                        },
                    },
                }
            )
        );
        try {
            mounted.result.triggerSearch('report');
            await vi.advanceTimersByTimeAsync(80);
            referenceMode.value = true;
            await flushPromises();
            expect(open.value).toBe(true);
            expect(mounted.result.items.value[0]?.result.primaryAction).toEqual({
                kind: 'file.reference',
                item: page.files[0],
            });
            finish(page);
            await flushPromises();
            expect(mounted.result.items.value[0]?.result.primaryAction?.kind).toBe(
                'file.reference'
            );
        } finally {
            finish(page);
            mounted.unmount();
        }
    });

    it('user sees shared ordering and dispatches the non-file action without opening a path', async () => {
        vi.useFakeTimers();
        const registry = new SearchProviderRegistry();
        const registration = registry.registerProvider({
            id: 'test-apps',
            intents: ['launcher'],
            async search() {
                return {
                    items: [
                        {
                            id: 'planner',
                            kind: 'miniapp',
                            group: 'miniapp',
                            label: 'Planner',
                            primaryAction: { kind: 'test.launch' },
                        },
                    ],
                };
            },
        });
        const actions = new SearchActionDispatcher();
        let launched: SearchActivationContext | undefined;
        actions.register('test.launch', (_action, context) => {
            launched = context;
            return { status: 'started' };
        });
        const openPath = vi.fn();
        const open = ref(false);
        const searchQuery = ref('plan');
        const mounted = await mountComposable(() =>
            useQuickSearchLogic(
                {
                    open,
                    searchQuery,
                    enabled: ref(true),
                    emitOpenUpdate: (value) => {
                        open.value = value;
                    },
                    getActivationContext: () => ({
                        input: { text: 'chosen input', files: [] },
                        conversation: { sessionId: 42 },
                    }),
                },
                {
                    registry,
                    actions,
                    openPath,
                    window: { hideSearchWindow: async () => {} },
                    quickSearch: {
                        getStatus: async () => ({
                            provider: 'everything',
                            db_loaded: true,
                            index_warmed: true,
                            last_refresh_ms: null,
                            last_error: null,
                        }),
                        prepareIndex: async () => {},
                        searchShortcuts: async () => ({
                            shortcuts: [],
                            files: [{ name: 'plan.md', path: 'D:/plan.md', source: 'file' }],
                            total_files: 1,
                            total_results: 1,
                            next_offset: 1,
                        }),
                    },
                }
            )
        );
        mounted.result.triggerSearch('plan');
        await vi.advanceTimersByTimeAsync(80);
        await flushPromises();
        expect(mounted.result.items.value.map(({ result }) => result.label)).toEqual([
            'Planner',
            'plan.md',
        ]);
        mounted.result.highlightedIndex.value = 0;
        expect(mounted.result.getReferenceCandidate()).toBeNull();
        mounted.result.handleContextMenu(new MouseEvent('contextmenu'), 0);
        expect(mounted.result.isContextMenuOpen.value).toBe(false);
        await mounted.result.openHighlightedItem();
        expect(openPath).not.toHaveBeenCalled();
        expect(launched).toMatchObject({
            query: 'plan',
            input: { text: 'chosen input', files: [] },
            conversation: { sessionId: 42 },
        });
        registration.dispose();
        await flushPromises();
        expect(mounted.result.items.value.map(({ result }) => result.label)).toEqual(['plan.md']);
        mounted.unmount();
    });
});
