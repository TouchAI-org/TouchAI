import { AppEvent, eventService } from '@services/EventService';
import type { QuickShortcutItem } from '@services/NativeService';
import { installProductAnalytics } from '@tests/utils/productAnalytics';
import { installSearchSurfaceBoundary } from '@tests/utils/searchSurface';
import { installSkillCommands } from '@tests/utils/skills';
import { getTauriInvokeCalls, mockTauriCommand } from '@tests/utils/tauri';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionMessage } from '@/types/session';
import SearchBar from '@/views/SearchView/components/SearchBar/index.vue';
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
    mockTauriCommand('database_operation', (payload: unknown) => {
        const { request } = payload as {
            request:
                | { kind: 'setting_get_many'; keys: string[] }
                | { kind: 'setting_get'; key: string }
                | { kind: 'setting_set'; key: string; value: string };
        };
        if (request.kind === 'setting_get_many') {
            return Object.fromEntries(request.keys.map((key) => [key, null]));
        }
        if (request.kind === 'setting_get') {
            return null;
        }
        return {
            id: 1,
            key: request.key,
            value: request.value,
            created_at: '',
            updated_at: '',
        };
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
    vi.useRealTimers();
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

describe('given the input contains an unfinished skill query', () => {
    it.each(['blur', 'Escape'] as const)(
        'user keeps the skill draft without starting file search after %s',
        async (dismissal) => {
            installSkillCommands();
            installProductAnalytics();
            const wrapper = mount(SearchView, {
                global: { plugins: [createPinia()] },
                attachTo: document.body,
            });
            await flushPromises();
            const input = wrapper.getComponent(SearchBar);
            const editor = wrapper.get<HTMLElement>('.ProseMirror');
            editor.element.focus();
            input.vm.insertTextAtCursor('$sum');
            await flushPromises();
            expect(wrapper.get('[role="option"]').text()).toContain('summary');
            expect(getTauriInvokeCalls('quick_search_search_shortcuts')).toEqual([]);

            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            if (dismissal === 'blur') editor.element.blur();
            else await editor.trigger('keydown', { key: 'Escape' });
            await flushPromises();
            await vi.advanceTimersByTimeAsync(100);

            expect(editor.text()).toBe('$sum');
            expect(wrapper.find('[data-testid="skill-picker-panel"]').exists()).toBe(
                dismissal === 'blur'
            );
            expect(getTauriInvokeCalls('quick_search_search_shortcuts')).toEqual([]);
            expect(wrapper.find('[data-testid="quick-search-panel"]').exists()).toBe(false);

            editor.element.blur();
            editor.element.focus();
            await flushPromises();
            expect(wrapper.get('[role="option"]').text()).toContain('summary');
            expect(getTauriInvokeCalls('quick_search_search_shortcuts')).toEqual([]);

            input.vm.insertTextAtCursor(' later');
            await flushPromises();
            await vi.advanceTimersByTimeAsync(100);
            expect(editor.text()).toBe('$sum later');
            expect(wrapper.find('[data-testid="skill-picker-panel"]').exists()).toBe(false);
            expect(getTauriInvokeCalls('quick_search_search_shortcuts')).toEqual([]);

            const bridge = (
                window as Window & {
                    __TOUCHAI_E2E__?: { setSearchQuery: (text: string) => void };
                }
            ).__TOUCHAI_E2E__;
            editor.element.blur();
            bridge!.setSearchQuery('TouchAI');
            await flushPromises();
            await vi.advanceTimersByTimeAsync(100);
            expect(getTauriInvokeCalls('quick_search_search_shortcuts')).toHaveLength(1);
            expect(getTauriInvokeCalls('quick_search_search_shortcuts')[0]?.payload).toMatchObject({
                query: 'TouchAI',
            });
        }
    );

    it('user hides and reopens the window with the skill results and selection preserved', async () => {
        installSkillCommands();
        installProductAnalytics();
        const wrapper = mount(SearchView, {
            global: { plugins: [createPinia()] },
            attachTo: document.body,
        });
        await flushPromises();
        const input = wrapper.getComponent(SearchBar);
        const editor = wrapper.get<HTMLElement>('.ProseMirror');
        editor.element.focus();
        input.vm.insertTextAtCursor('$sum');
        await flushPromises();
        await editor.trigger('keydown', { key: 'ArrowDown' });
        const selectedId = editor.attributes('aria-activedescendant');

        editor.element.blur();
        await eventService.emit(AppEvent.SEARCH_SURFACE_HIDDEN, {
            sequence: 1,
            reason: 'app-blur-hide',
        });
        await flushPromises();
        expect(wrapper.get('[aria-selected="true"]').text()).toContain('summary');
        expect(editor.text()).toBe('$sum');

        await eventService.emit(AppEvent.SEARCH_SURFACE_SHOWN, {
            source: 'main',
            sequence: 2,
            rendererEpoch: 1,
            showEpoch: 2,
            hostEpoch: 2,
            generation: 100,
        });
        await flushPromises();
        expect(editor.attributes('aria-activedescendant')).toBe(selectedId);
        expect(wrapper.get('[aria-selected="true"]').text()).toContain('summary');
        expect(wrapper.find('[data-testid="quick-search-panel"]').exists()).toBe(false);
        expect(getTauriInvokeCalls('quick_search_search_shortcuts')).toEqual([]);
    });
});

describe('given a file has been referenced in the draft', () => {
    it('user given a completed @ reference when continuing ordinary text then keeps file search closed until a new @ query', async () => {
        installSkillCommands();
        installProductAnalytics();
        mockTauriCommand('quick_search_search_shortcuts', {
            shortcuts: [],
            files: [result],
            total_files: 1,
            total_results: 1,
            next_offset: 1,
        });
        const wrapper = mount(SearchView, {
            global: { plugins: [createPinia()] },
            attachTo: document.body,
        });
        await flushPromises();
        const input = wrapper.getComponent(SearchBar);
        await input.vm.focus();
        input.vm.insertTextAtCursor('hi @touch');
        await vi.waitFor(() => expect(wrapper.findAll('[role="option"]')).toHaveLength(1));
        await wrapper.get('.ProseMirror').trigger('keydown', { key: 'ArrowDown' });
        await wrapper.get('.ProseMirror').trigger('keydown', { key: 'Tab' });
        await flushPromises();
        expect(wrapper.find('[data-attachment-tag]').exists()).toBe(true);
        const searchCount = getTauriInvokeCalls('quick_search_search_shortcuts').length;
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        input.vm.insertTextAtCursor('please explain');
        await flushPromises();
        await vi.advanceTimersByTimeAsync(400);
        expect(getTauriInvokeCalls('quick_search_search_shortcuts')).toHaveLength(searchCount);
        const panel = wrapper.find('[data-testid="quick-search-panel"]');
        expect(panel.exists() && panel.isVisible()).toBe(false);

        input.vm.insertTextAtCursor(' @touch');
        await flushPromises();
        await vi.advanceTimersByTimeAsync(400);
        expect(wrapper.get('[data-testid="quick-search-panel"]').isVisible()).toBe(true);
        expect(getTauriInvokeCalls('quick_search_search_shortcuts').length).toBeGreaterThan(
            searchCount
        );
        wrapper.unmount();
    });
});

describe('given the main window already contains a conversation', () => {
    it('user opens Skills without starting a file-search lifecycle', async () => {
        installSkillCommands();
        installProductAnalytics();
        const wrapper = mount(SearchView, {
            global: { plugins: [createPinia()] },
            attachTo: document.body,
        });
        await flushPromises();
        const bridge = (
            window as Window & {
                __TOUCHAI_E2E__?: { setConversation: (messages: SessionMessage[]) => void };
            }
        ).__TOUCHAI_E2E__;
        expect(bridge).toBeDefined();
        bridge!.setConversation([
            {
                id: 'existing-message',
                role: 'user',
                content: 'Existing conversation',
                parts: [{ id: 'text', type: 'text', content: 'Existing conversation' }],
                timestamp: 1,
            },
        ]);
        await flushPromises();
        const initialIndexRequests = getTauriInvokeCalls('quick_search_prepare_index').length;
        const input = wrapper.getComponent(SearchBar);
        await input.vm.focus();
        input.vm.insertTextAtCursor('$sum');
        await flushPromises();

        expect(wrapper.get('[data-testid="skill-picker-panel"] [role="option"]').text()).toContain(
            'summary'
        );
        expect(wrapper.find('[data-testid="quick-search-panel"]').exists()).toBe(false);
        expect(getTauriInvokeCalls('quick_search_prepare_index')).toHaveLength(
            initialIndexRequests
        );
        expect(getTauriInvokeCalls('quick_search_search_shortcuts')).toEqual([]);
    });
});
