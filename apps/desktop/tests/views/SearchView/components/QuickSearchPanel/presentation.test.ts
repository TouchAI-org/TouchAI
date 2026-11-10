import { getTauriInvokeCalls, mockTauriCommand } from '@tests/utils/tauri';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import { searchActions, searchProviders } from '@/services/SearchService';
import { useSettingsStore } from '@/stores/settings';
import QuickSearchPanel from '@/views/SearchView/components/QuickSearchPanel/index.vue';

enableAutoUnmount(afterEach);

beforeEach(() => {
    setLocale('en-US');
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        queueMicrotask(() => callback(performance.now()));
        return 0;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    mockTauriCommand('database_query', { rows: [], rowsAffected: 0, lastInsertId: null });
    mockTauriCommand('quick_search_prepare_index', undefined);
    mockTauriCommand('quick_search_get_status', { db_loaded: true, index_warmed: true });
    mockTauriCommand('quick_search_get_shortcut_icons', {});
    mockTauriCommand('quick_search_get_image_thumbnails', {});
    mockTauriCommand('quick_search_search_shortcuts', (payload: unknown) => ({
        shortcuts: [],
        files: [
            {
                name: (payload as { offset: number }).offset ? 'Second file' : 'First file',
                path: `D:/file-${(payload as { offset: number }).offset}.txt`,
                source: 'file',
            },
        ],
        total_files: 2,
        total_results: 2,
        next_offset: 1,
    }));
});

afterEach(() => vi.unstubAllGlobals());

async function openFiles(pinia = createPinia()) {
    const wrapper = mount(QuickSearchPanel, {
        props: { open: true, searchQuery: 'file' },
        global: { plugins: [pinia] },
        attachTo: document.body,
    });
    wrapper.vm.open();
    await flushPromises();
    wrapper.vm.toggleViewMode();
    await flushPromises();
    expect(wrapper.text()).toContain('First file');
    return wrapper;
}

describe('given files use the shared result surface', () => {
    it('user sees a non-file contribution in the same panel without file icons, Tab launch, or a file menu', async () => {
        let launched = 0;
        const registration = searchProviders.registerProvider({
            id: 'test-app',
            intents: ['launcher'],
            async search() {
                return {
                    items: [
                        {
                            id: 'planner',
                            kind: 'miniapp',
                            group: 'miniapp',
                            label: 'Planner',
                            iconSrc: 'data:image/svg+xml,test',
                            primaryAction: { kind: 'test.launch' },
                        },
                    ],
                };
            },
        });
        const handler = searchActions.register('test.launch', () => {
            launched++;
            return { status: 'started' };
        });
        try {
            const wrapper = await openFiles();
            const rows = () => wrapper.findAll('[data-slot="result-item"]');
            expect(rows().map((row) => row.text())).toEqual([
                'Planner',
                expect.stringContaining('First file'),
            ]);
            wrapper.vm.moveSelection('down');
            await flushPromises();
            expect(wrapper.get('[data-slot="result-panel-footer"]').text()).not.toContain('Tab');
            expect(wrapper.vm.getReferenceCandidate()).toBeNull();
            await rows()[0]!.trigger('contextmenu');
            expect(document.querySelector('[role="menu"]')).toBeNull();
            await rows()[0]!.trigger('click');
            await flushPromises();
            expect(launched).toBe(1);
            expect(wrapper.emitted('actionOutcome')).toEqual([[{ status: 'started' }]]);
            await new Promise(requestAnimationFrame);
            expect(
                getTauriInvokeCalls('quick_search_get_shortcut_icons').flatMap(
                    (call) => (call.payload as { paths: string[] }).paths
                )
            ).not.toContain('planner');
            registration.dispose();
            await flushPromises();
            expect(rows().map((row) => row.text())).toEqual([
                expect.stringContaining('First file'),
            ]);
        } finally {
            registration.dispose();
            handler.dispose();
        }
    });
    it('user given a conversation when browsing file references then navigates compact rows and returns to the previous layout afterward', async () => {
        const wrapper = await openFiles();
        wrapper.vm.toggleViewMode();
        await wrapper.setProps({ compact: true, referenceMode: true });
        await flushPromises();
        expect(wrapper.find('.quick-search-grid').exists()).toBe(false);
        expect(wrapper.text()).toContain('D:/file-0.txt');
        expect(wrapper.find('[data-testid="quick-search-view-toggle"]').exists()).toBe(false);
        expect(wrapper.find('[data-slot="result-panel-footer"]').exists()).toBe(false);
        wrapper.vm.moveSelection('down');
        expect(wrapper.vm.getReferenceCandidate()?.name).toBe('First file');
        wrapper.vm.toggleViewMode();
        await flushPromises();
        expect(wrapper.find('.quick-search-grid').exists()).toBe(false);
        await wrapper.setProps({ compact: false, referenceMode: false });
        expect(wrapper.find('.quick-search-grid').exists()).toBe(true);
    });

    it('user given a collapsed file grid when expanding its second stage then sees newly revealed icons without another scroll', async () => {
        vi.useFakeTimers();
        try {
            const files = Array.from({ length: 60 }, (_, index) => ({
                name: index === 0 ? 'First file' : `Document ${index}.md`,
                path: `D:/docs/document-${index}.md`,
                source: 'file',
            }));
            mockTauriCommand('quick_search_search_shortcuts', {
                shortcuts: [],
                files,
                total_files: files.length,
                total_results: files.length,
                next_offset: files.length,
            });
            mockTauriCommand('quick_search_get_shortcut_icons', (payload: unknown) =>
                Object.fromEntries(
                    (payload as { paths: string[] }).paths.map((path) => [
                        path,
                        `data:image/png;base64,${btoa(path)}`,
                    ])
                )
            );
            const wrapper = await openFiles();
            wrapper.vm.toggleViewMode();
            await flushPromises();
            const viewport = wrapper.get('[data-slot="result-panel-viewport"]');
            let committedHeight = 0;
            Object.defineProperties(viewport.element, {
                clientWidth: { configurable: true, value: 750 },
                clientHeight: { configurable: true, get: () => committedHeight },
            });
            window.dispatchEvent(new Event('resize'));
            await flushPromises();
            await vi.advanceTimersByTimeAsync(0);
            await flushPromises();
            const nextBatchRow = wrapper.findAll('[data-slot="result-item"]')[20]!;
            expect(nextBatchRow.find('img').exists()).toBe(false);

            await viewport.trigger('wheel', { deltaY: 120, deltaX: 0 });
            committedHeight = Number.parseFloat((viewport.element as HTMLElement).style.height);
            await vi.advanceTimersByTimeAsync(0);
            await flushPromises();

            expect(nextBatchRow.get('img').attributes('src')).toBe(
                `data:image/png;base64,${btoa(files[20]!.path)}`
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it('user given several pages of matches when viewing the footer then reads page position and result count as separate groups', async () => {
        mockTauriCommand('quick_search_search_shortcuts', {
            shortcuts: [],
            files: [{ name: 'First file', path: 'D:/file-0.txt', source: 'file' }],
            total_files: 223351,
            total_results: 223351,
            next_offset: 1,
        });
        setLocale('zh-CN');
        const wrapper = await openFiles();
        const groups = () => wrapper.findAll('[data-slot="result-panel-status"] > span');
        expect(groups().map((group) => group.text())).toEqual(['1/3723 页', '223351 项']);
        setLocale('en-US');
        await flushPromises();
        expect(groups().map((group) => group.text())).toEqual(['1/3723', '223351 results']);
    });

    it('user sees open and back shortcuts only after selecting a file', async () => {
        const wrapper = await openFiles();
        const footer = () => wrapper.get('[data-slot="result-panel-footer"]');
        expect(
            footer()
                .findAll('kbd')
                .map((key) => key.text())
        ).toEqual(['↓', 'Ctrl', 'G']);
        expect(footer().text()).not.toContain('Reference');
        wrapper.vm.moveSelection('down');
        await flushPromises();
        expect(
            footer()
                .findAll('kbd')
                .map((key) => key.text())
        ).toEqual(['↑', '↓', 'Enter', 'Tab', 'Esc', 'Ctrl', 'G']);
        expect(footer().text()).toContain('Open');
        expect(footer().text()).toContain('Back');
        wrapper.vm.collapseToDefault();
        await flushPromises();
        expect(
            footer()
                .findAll('kbd')
                .map((key) => key.text())
        ).toEqual(['↓', 'Ctrl', 'G']);
    });

    it('user given an @ result list when choosing no row then sees no Tab hint until selecting a file', async () => {
        const wrapper = await openFiles();
        await wrapper.setProps({ referenceMode: true });
        await flushPromises();
        expect(wrapper.get('[data-slot="result-panel-footer"]').text()).not.toContain('Tab');
        wrapper.vm.moveSelection('down');
        await flushPromises();
        expect(wrapper.get('[data-slot="result-panel-footer"]').text()).toContain('Tab');
        expect(wrapper.vm.getReferenceCandidate()?.name).toBe('First file');
    });

    it('user sees the configured view shortcut and switches layouts from the footer', async () => {
        const pinia = createPinia();
        const wrapper = await openFiles(pinia);
        const settings = useSettingsStore(pinia);
        const toggle = () => wrapper.get('[data-testid="quick-search-view-toggle"]');

        expect(
            toggle()
                .findAll('kbd')
                .map((key) => key.text())
        ).toEqual(['Ctrl', 'G']);
        expect(toggle().text()).toContain('Switch to grid layout');
        expect(toggle().attributes('aria-label')).toBe('Switch to grid layout');
        setLocale('zh-CN');
        await flushPromises();
        expect(toggle().text()).toContain('切换网格布局');
        const pointerDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
        toggle().element.dispatchEvent(pointerDown);
        expect(pointerDown.defaultPrevented).toBe(true);
        await toggle().trigger('click');
        await flushPromises();
        expect(wrapper.find('.quick-search-grid').exists()).toBe(true);
        expect(toggle().text()).toContain('切换列表布局');

        settings.settings.searchKeybindings['search.quickSearch.toggleView'] = 'Alt+V';
        await flushPromises();
        expect(
            toggle()
                .findAll('kbd')
                .map((key) => key.text())
        ).toEqual(['Alt', 'V']);

        settings.settings.searchKeybindings['search.quickSearch.toggleView'] = null;
        await flushPromises();
        expect(toggle().find('kbd').exists()).toBe(false);
        await toggle().trigger('click');
        await flushPromises();
        expect(wrapper.find('.quick-search-grid').exists()).toBe(false);
    });

    it('user opens the highlighted list row menu from the keyboard', async () => {
        const wrapper = await openFiles();
        wrapper.vm.moveSelection('down');
        await flushPromises();
        wrapper.vm.openContextMenuForHighlightedItem();
        await flushPromises();

        const menu = document.querySelector('[role="menu"]');
        expect(menu?.textContent).toContain('Open containing folder');
        expect(menu?.textContent).toContain('Copy path');
        wrapper.vm.closeContextMenu();
    });

    it('user receives more files through the visible scroll area and keeps their position', async () => {
        const wrapper = await openFiles();
        const viewport = wrapper.get('[data-slot="result-panel-viewport"]');
        Object.defineProperties(viewport.element, {
            clientHeight: { configurable: true, value: 300 },
            scrollHeight: { configurable: true, value: 1200 },
        });
        viewport.element.scrollTop = 900;
        await viewport.trigger('scroll');
        await flushPromises();

        expect(wrapper.text()).toContain('First file');
        expect(wrapper.text()).toContain('Second file');
        expect(viewport.element.scrollTop).toBe(900);
        const requests = getTauriInvokeCalls('quick_search_search_shortcuts');
        expect(requests[requests.length - 1]?.payload).toMatchObject({
            offset: 1,
        });
    });
});
