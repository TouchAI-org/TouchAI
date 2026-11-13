import { AppEvent, eventService } from '@services/EventService';
import type { DatabaseQueryRequest } from '@services/NativeService/database';
import { setActiveSettingsService } from '@services/SettingsService';
import { installSearchSurfaceBoundary } from '@tests/utils/searchSurface';
import { getTauriInvokeCalls, mockTauriCommand } from '@tests/utils/tauri';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, disposePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import SearchView from '@/views/SearchView/index.vue';

vi.setConfig({ testTimeout: 20_000 });

vi.mock('@tauri-apps/api/window', async () => {
    const { searchSurfaceWindow, searchSurfaceMonitor } =
        await import('@tests/utils/searchSurface');
    return {
        getCurrentWindow: () => searchSurfaceWindow,
        currentMonitor: async () => searchSurfaceMonitor,
    };
});

const rangeGeometry = {
    getBoundingClientRect: Object.getOwnPropertyDescriptor(
        Range.prototype,
        'getBoundingClientRect'
    ),
    getClientRects: Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects'),
};

let wrapper: VueWrapper | undefined;
let pinia: ReturnType<typeof createPinia>;
let reads: Array<(name: string) => void>;

beforeEach(() => {
    reads = [];
    pinia = createPinia();
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
    mockTauriCommand('get_runtime_info', { isE2eTestMode: true });
    mockTauriCommand('database_query', async (payload: unknown) => {
        const { request } = payload as { request: DatabaseQueryRequest };
        if (request.method === 'all' && request.sql.includes('from "models" inner join')) {
            const rows = await new Promise<Array<Record<string, unknown>>>((resolve) => {
                reads.push((name) =>
                    resolve([
                        {
                            id: 1,
                            model_id: 'fixture-model',
                            name,
                            provider_id: 1,
                            provider_enabled: 1,
                            provider_name: 'Fixture',
                            provider_driver: 'openai',
                            provider_logo: null,
                            is_default: 0,
                            attachment: 0,
                            reasoning: 0,
                            tool_call: 0,
                            open_weights: 0,
                            modalities: null,
                        },
                    ])
                );
            });
            return { rows, rowsAffected: 0, lastInsertId: null };
        }
        const rows = request.sql.startsWith('insert into "settings"')
            ? [{ key: request.params?.[0], value: request.params?.[1] }]
            : [];
        return { rows, rowsAffected: 0, lastInsertId: null };
    });
});

afterEach(async () => {
    wrapper?.unmount();
    wrapper = undefined;
    disposePinia(pinia);
    await flushPromises();
    setActiveSettingsService(null);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const [name, descriptor] of Object.entries(rangeGeometry)) {
        if (descriptor) Object.defineProperty(Range.prototype, name, descriptor);
        else Reflect.deleteProperty(Range.prototype, name);
    }
    document.body.innerHTML = '';
});

async function openView() {
    wrapper = mount(SearchView, { attachTo: document.body, global: { plugins: [pinia] } });
    await flushPromises();
    await vi.waitFor(
        () =>
            expect(
                getTauriInvokeCalls('plugin:event|listen').some(
                    (call) =>
                        (call.payload as { event?: string })?.event === AppEvent.AI_MODELS_UPDATED
                )
            ).toBe(true),
        { timeout: 10_000 }
    );
}

async function toggleModels() {
    await wrapper!
        .get('[data-testid="search-view"]')
        .trigger('keydown', { key: 'm', code: 'KeyM', ctrlKey: true });
    await flushPromises();
}

async function invalidateModels() {
    await eventService.emit(AppEvent.AI_MODELS_UPDATED, { updatedAt: 0 });
    await flushPromises();
}

describe('user opens models while the model list changes', () => {
    it.each([1, 2])(
        'user opening models waits for a current list after %i query invalidations',
        async (invalidations) => {
            await openView();
            await toggleModels();
            await vi.waitFor(() => expect(reads).toHaveLength(1));

            for (let updateIndex = 0; updateIndex < invalidations; updateIndex += 1) {
                await invalidateModels();
                reads[updateIndex]!('Outdated model');
                await flushPromises();

                expect(wrapper!.find('[data-search-overlay-host]').exists()).toBe(false);
                await vi.waitFor(() => expect(reads).toHaveLength(updateIndex + 2));
            }

            reads[invalidations]!('Current model');
            await vi.waitFor(() =>
                expect(wrapper!.get('[data-search-overlay-host]').text()).toContain('Current model')
            );
            expect(wrapper!.get('[data-search-overlay-host]').text()).not.toContain(
                'Outdated model'
            );
        }
    );

    it('user cancels an opening while its refreshed query is pending and the popup stays closed', async () => {
        await openView();
        await toggleModels();
        await vi.waitFor(() => expect(reads).toHaveLength(1));
        await invalidateModels();
        reads[0]!('Previous model');
        await vi.waitFor(() => expect(reads).toHaveLength(2));

        await toggleModels();
        reads[1]!('Current model');
        await flushPromises();

        expect(wrapper!.find('[data-search-overlay-host]').exists()).toBe(false);
    });

    it('user cancels a newer opening after an old query finishes and the popup stays closed', async () => {
        await openView();
        await toggleModels();
        await vi.waitFor(() => expect(reads).toHaveLength(1));
        await toggleModels();
        await invalidateModels();
        await toggleModels();
        await vi.waitFor(() => expect(reads).toHaveLength(2));

        reads[0]!('Previous model');
        await flushPromises();
        await toggleModels();
        reads[1]!('Current model');
        await flushPromises();

        expect(wrapper!.find('[data-search-overlay-host]').exists()).toBe(false);
    });

    it('user sees the current model list even when an invalidated query finishes later', async () => {
        await openView();
        await toggleModels();
        await vi.waitFor(() => expect(reads).toHaveLength(1));
        await toggleModels();
        await invalidateModels();
        await toggleModels();
        await vi.waitFor(() => expect(reads).toHaveLength(2));

        reads[1]!('Current model');
        await vi.waitFor(() =>
            expect(wrapper!.get('[data-search-overlay-host]').text()).toContain('Current model')
        );
        reads[0]!('Previous model');
        await flushPromises();

        expect(wrapper!.get('[data-search-overlay-host]').text()).toContain('Current model');
        expect(wrapper!.get('[data-search-overlay-host]').text()).not.toContain('Previous model');
    });
});
