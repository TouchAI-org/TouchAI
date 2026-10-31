import { AppEvent, eventService } from '@services/EventService';
import { popupManager } from '@services/PopupService';
import { deferred, installProductAnalytics } from '@tests/utils/productAnalytics';
import { getTauriInvokeCalls, mockTauriCommand } from '@tests/utils/tauri';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import SearchView from '@/views/SearchView/index.vue';

// Window geometry and observer delivery are browser/OS boundaries.
vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => ({
        label: 'main',
        isVisible: async () => true,
        isAlwaysOnTop: async () => false,
        isMaximized: async () => false,
        isFullscreen: async () => false,
        scaleFactor: async () => 1,
        outerPosition: async () => ({ toLogical: () => ({ x: 0, y: 0 }) }),
        outerSize: async () => ({ toLogical: () => ({ width: 750, height: 60 }) }),
        innerSize: async () => ({ toLogical: () => ({ width: 750, height: 60 }) }),
        onResized: async () => () => undefined,
        onMoved: async () => () => undefined,
    }),
    currentMonitor: async () => ({
        size: { width: 1920, height: 1080 },
        position: { x: 0, y: 0 },
        scaleFactor: 1,
    }),
}));
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
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        queueMicrotask(() => callback(performance.now()));
        return 0;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
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
    mockTauriCommand('database_query', (payload) => {
        const { request } = payload as { request: { sql: string; params: unknown[] } };
        const rows = request.sql.startsWith('insert into "settings"')
            ? [{ key: request.params[0], value: request.params[1] }]
            : [];
        return { rows, rowsAffected: 0, lastInsertId: null };
    });
    mockTauriCommand('get_runtime_info', { isE2eTestMode: true });
    mockTauriCommand('get_search_window_state', {
        defaults: { width: 750, height: 60 },
        currentWidth: 750,
        currentHeight: 60,
        heightMode: 'auto',
    });
    mockTauriCommand('set_search_window_defaults', (payload) => {
        return (payload as { defaults: { width: number; height: number } }).defaults;
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
    for (const [name, descriptor] of Object.entries(rangeGeometry)) {
        if (descriptor) Object.defineProperty(Range.prototype, name, descriptor);
        else Reflect.deleteProperty(Range.prototype, name);
    }
});

describe('user opens history from the search page', () => {
    it('user gets no history exposure when another popup supersedes a pending native open', async () => {
        const telemetry = installProductAnalytics();
        const historyWindow = deferred<void>();
        mockTauriCommand('show_popup_window', (payload) => {
            const { params } = payload as { params: { popupType: string } };
            return params.popupType === 'session-history-popup' ? historyWindow.promise : undefined;
        });
        const wrapper = mount(SearchView, {
            global: { plugins: [createPinia()] },
            attachTo: document.body,
        });
        await flushPromises();
        await wrapper
            .get('[data-testid="search-view"]')
            .trigger('keydown', { key: 'h', code: 'KeyH', ctrlKey: true });
        await flushPromises();
        expect(getTauriInvokeCalls('show_popup_window')).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    payload: expect.objectContaining({
                        params: expect.objectContaining({ popupType: 'session-history-popup' }),
                    }),
                }),
            ])
        );

        await popupManager.show('model-dropdown-popup', wrapper.element as HTMLElement, {
            models: [],
            activeModelId: '',
            activeProviderId: null,
            selectedModelId: '',
            selectedProviderId: null,
            searchQuery: '',
        });
        historyWindow.resolve();
        await flushPromises();
        expect(
            telemetry.events.filter(
                (event) =>
                    event.attributes.surface === 'history' ||
                    event.attributes.feature === 'history' ||
                    event.attributes.search_scope === 'history'
            )
        ).toEqual([]);
        expect(telemetry.active.size).toBe(0);

        const state = popupManager.state;
        await eventService.emit(AppEvent.POPUP_CLOSED, {
            popupId: state.currentPopupId!,
            popupSessionVersion: state.currentPopupSessionVersion!,
            windowLabel: state.currentWindowLabel!,
            type: 'model-dropdown-popup',
        });
        await flushPromises();
        await wrapper
            .get('[data-testid="search-view"]')
            .trigger('keydown', { key: 'h', code: 'KeyH', ctrlKey: true });
        await flushPromises();
        expect(telemetry.events.some((event) => event.attributes.surface === 'history')).toBe(true);
        expect(telemetry.events.some((event) => event.attributes.feature === 'history')).toBe(true);
    });
});
