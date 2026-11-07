import { AppEvent, eventService } from '@services/EventService';
import type { QuickShortcutItem } from '@services/NativeService';
import { installProductAnalytics } from '@tests/utils/productAnalytics';
import { installSearchSurfaceBoundary } from '@tests/utils/searchSurface';
import { mockTauriCommand } from '@tests/utils/tauri';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import SearchView from '@/views/SearchView/index.vue';

vi.mock('@tauri-apps/api/window', async () => {
    const { searchSurfaceWindow, searchSurfaceMonitor } =
        await import('@tests/utils/searchSurface');
    return {
        getCurrentWindow: () => searchSurfaceWindow,
        currentMonitor: async () => searchSurfaceMonitor,
    };
});
enableAutoUnmount(afterEach);

const rangeGeometry = {
    getBoundingClientRect: Object.getOwnPropertyDescriptor(
        Range.prototype,
        'getBoundingClientRect'
    ),
    getClientRects: Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects'),
};
const result: QuickShortcutItem = {
    name: 'TouchAI',
    path: 'D:/TouchAI.lnk',
    source: 'desktop_user',
};

beforeEach(() => {
    setActivePinia(createPinia());
    installSearchSurfaceBoundary();
    Object.defineProperties(Range.prototype, {
        getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
        getClientRects: { configurable: true, value: () => [] },
    });
    vi.stubGlobal(
        'ResizeObserver',
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        }
    );
    mockTauriCommand('database_query', (payload: unknown) => {
        const { request } = payload as { request: { sql: string; params: unknown[] } };
        const rows = request.sql.startsWith('insert into "settings"')
            ? [{ key: request.params[0], value: request.params[1] }]
            : [];
        return { rows, rowsAffected: 0, lastInsertId: null };
    });
    mockTauriCommand('get_runtime_info', { isE2eTestMode: true });

    mockTauriCommand('quick_search_search_shortcuts', {
        shortcuts: [],
        files: [],
        total_files: 0,
        total_results: 0,
        next_offset: 0,
    });
    mockTauriCommand('quick_search_get_status', {
        provider: 'everything',
        db_loaded: true,
        index_warmed: true,
        last_refresh_ms: null,
        last_error: null,
    });
    mockTauriCommand('quick_search_prepare_index', undefined);
    mockTauriCommand('quick_search_get_shortcut_icons', {});
    mockTauriCommand('quick_search_get_image_thumbnails', {});
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const [name, descriptor] of Object.entries(rangeGeometry)) {
        if (descriptor) Object.defineProperty(Range.prototype, name, descriptor);
        else Reflect.deleteProperty(Range.prototype, name);
    }
});

describe('user hides the search surface while quick search is open', () => {
    it('user keeps the quick search query and results after the surface hides and reopens', async () => {
        const telemetry = installProductAnalytics();
        const wrapper = mount(SearchView, {
            global: { plugins: [createPinia()] },
            attachTo: document.body,
        });
        await flushPromises();

        const bridge = (
            window as Window & {
                __TOUCHAI_E2E__?: {
                    setSearchFixture: (query: string, results: QuickShortcutItem[]) => void;
                    setSearchQuery: (text: string) => void;
                };
            }
        ).__TOUCHAI_E2E__;
        expect(bridge).toBeDefined();
        bridge!.setSearchFixture('touchai', [result]);
        bridge!.setSearchQuery('touchai');

        await vi.waitFor(
            () => {
                expect(wrapper.find('[data-testid="quick-search-panel"]').text()).toContain(
                    'TouchAI'
                );
                expect(
                    telemetry.events.some(
                        (event) =>
                            event.eventName === 'product.feature_exposed' &&
                            event.attributes.feature === 'quick_search'
                    )
                ).toBe(true);
            },
            { timeout: 2_000 }
        );
        expect(wrapper.get('.search-bar-editor-content').text()).toContain('touchai');

        await eventService.emit(AppEvent.SEARCH_SURFACE_HIDDEN, {
            sequence: 1,
            reason: 'app-blur-hide',
        });
        await flushPromises();

        const completedSearchEvents = telemetry.events.filter(
            (event) => event.eventName === 'search.completed'
        );
        expect(completedSearchEvents).toHaveLength(1);
        const quickSearchOperationId = completedSearchEvents[0]?.operationId;
        expect(quickSearchOperationId).toBeDefined();
        expect(telemetry.released).toContain(quickSearchOperationId);
        expect(telemetry.active.has(quickSearchOperationId!)).toBe(false);
        expect(telemetry.active.size).toBe(0);
        expect(wrapper.find('[data-testid="quick-search-panel"]').exists()).toBe(true);
        expect(wrapper.get('[data-testid="quick-search-panel"]').text()).toContain('TouchAI');
        expect(wrapper.get('.search-bar-editor-content').text()).toContain('touchai');

        await eventService.emit(AppEvent.SEARCH_SURFACE_SHOWN, {
            source: 'main',
            sequence: 2,
            rendererEpoch: 1,
            showEpoch: 2,
            hostEpoch: 2,
            generation: 100,
        });
        await flushPromises();

        expect(telemetry.active.has(quickSearchOperationId!)).toBe(false);
        expect(telemetry.active.size).toBe(0);
        expect(
            telemetry.events.filter((event) => event.eventName === 'search.completed')
        ).toHaveLength(1);
        expect(wrapper.get('[data-testid="quick-search-panel"]').text()).toContain('TouchAI');
        expect(wrapper.get('.search-bar-editor-content').text()).toContain('touchai');
        wrapper.unmount();
    });
});
