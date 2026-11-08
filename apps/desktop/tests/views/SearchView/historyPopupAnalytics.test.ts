import { deferred, installProductAnalytics } from '@tests/utils/productAnalytics';
import { acknowledgeSearchRegions, installSearchSurfaceBoundary } from '@tests/utils/searchSurface';
import { mockTauriCommand } from '@tests/utils/tauri';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import SearchView from '@/views/SearchView/index.vue';

// Window geometry and observer delivery are browser/OS boundaries.
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
    mockTauriCommand('database_operation', (payload: unknown) => {
        const { request } = payload as {
            request:
                | { kind: 'setting_get_many'; keys: string[] }
                | { kind: 'setting_get'; key: string }
                | { kind: 'setting_set'; key: string; value: string }
                | { kind: 'session_list' };
        };
        if (request.kind === 'setting_get_many') {
            return Object.fromEntries(request.keys.map((key) => [key, null]));
        }
        if (request.kind === 'setting_get') {
            return null;
        }
        if (request.kind === 'setting_set') {
            return {
                id: 1,
                key: request.key,
                value: request.value,
                created_at: '',
                updated_at: '',
            };
        }
        return [];
    });
    mockTauriCommand('get_runtime_info', { isE2eTestMode: true });
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const [name, descriptor] of Object.entries(rangeGeometry)) {
        if (descriptor) Object.defineProperty(Range.prototype, name, descriptor);
        else Reflect.deleteProperty(Range.prototype, name);
    }
});

describe('user opens history from the search page', () => {
    it('user gets no history exposure when another overlay supersedes a pending native region', async () => {
        const telemetry = installProductAnalytics();
        const historyRegion = deferred<ReturnType<typeof acknowledgeSearchRegions>>();
        let pendingRegion: unknown;
        mockTauriCommand('set_search_window_regions', (payload: unknown) => {
            const { regions } = payload as { regions: unknown[] };
            if (regions.length > 1 && !pendingRegion) {
                pendingRegion = payload;
                return historyRegion.promise;
            }
            return acknowledgeSearchRegions(payload);
        });
        const wrapper = mount(SearchView, {
            global: { plugins: [createPinia()] },
            attachTo: document.body,
        });
        await flushPromises();
        await wrapper
            .get('[data-testid="search-view"]')
            .trigger('keydown', { key: 'h', code: 'KeyH', ctrlKey: true });
        await vi.waitFor(() => expect(pendingRegion).toBeDefined());
        expect(wrapper.get('[data-search-overlay-host]').attributes('style')).toContain(
            'visibility: hidden'
        );

        await wrapper
            .get('[data-testid="search-view"]')
            .trigger('keydown', { key: 'm', code: 'KeyM', ctrlKey: true });
        await flushPromises();
        historyRegion.resolve(acknowledgeSearchRegions(pendingRegion));
        await vi.waitFor(() => {
            expect(wrapper.get('[data-search-overlay-host]').attributes('style')).toContain(
                'visibility: visible'
            );
        });
        expect(
            telemetry.events.filter(
                (event) =>
                    event.attributes.surface === 'history' ||
                    event.attributes.feature === 'history' ||
                    event.attributes.search_scope === 'history'
            )
        ).toEqual([]);
        expect(telemetry.active.size).toBe(0);

        await wrapper
            .get('[data-testid="search-view"]')
            .trigger('keydown', { key: 'h', code: 'KeyH', ctrlKey: true });
        await vi.waitFor(() => {
            expect(telemetry.events.some((event) => event.attributes.surface === 'history')).toBe(
                true
            );
            expect(telemetry.events.some((event) => event.attributes.feature === 'history')).toBe(
                true
            );
        });
    });
});
