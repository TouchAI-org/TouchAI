import { createAgentWindowFixture } from '@tests/utils/agentWindow';
import { createMainViewClients } from '@tests/utils/mainViewClients';
import { installSearchSurfaceBoundary } from '@tests/utils/searchSurface';
import { getTauriInvokeCalls, mockTauriCommand } from '@tests/utils/tauri';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, disposePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppEvent } from '@/app/api/search/events';
import type { DatabaseQueryRequest } from '@/platform/native/database';
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
let fixture: ReturnType<typeof createAgentWindowFixture>;
let clients: ReturnType<typeof createMainViewClients>;
let reads: Array<(name: string) => void>;

beforeEach(async () => {
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
    fixture = createAgentWindowFixture('main', undefined, {
        async aroundInvoke(call, next) {
            const { request } = (call.payload ?? {}) as { request?: DatabaseQueryRequest };
            if (
                call.cmd === 'database_query' &&
                request?.method === 'all' &&
                request.sql.includes('from "models" inner join')
            ) {
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
            return next();
        },
    });
    await fixture.window.ready;
    await fixture.window.settings.initialize();
    clients = createMainViewClients(fixture.window);
});

afterEach(async () => {
    wrapper?.unmount();
    wrapper = undefined;
    disposePinia(pinia);
    clients.dispose();
    await fixture.window.dispose();
    await flushPromises();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const [name, descriptor] of Object.entries(rangeGeometry)) {
        if (descriptor) Object.defineProperty(Range.prototype, name, descriptor);
        else Reflect.deleteProperty(Range.prototype, name);
    }
    document.body.innerHTML = '';
});

async function openView() {
    wrapper = mount(SearchView, {
        attachTo: document.body,
        global: {
            plugins: [pinia],
            provide: clients.provide,
        },
    });
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
    await emit(AppEvent.AI_MODELS_UPDATED, { updatedAt: 0 });
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
import { emit } from '@tauri-apps/api/event';
