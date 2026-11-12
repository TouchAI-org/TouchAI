import { mockTauriCommand } from '@tests/utils/tauri';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';

import { setLocale } from '@/i18n';
import type { SkillMetadata } from '@/services/AgentService/skills';
import type { QuickSearchResult } from '@/services/NativeService';
import QuickSearchPanel from '@/views/SearchView/components/QuickSearchPanel/index.vue';
import { useSkillAutocomplete } from '@/views/SearchView/components/SearchBar/composables/useSkillAutocomplete';
import SkillPickerPanel from '@/views/SearchView/components/SearchBar/SkillPickerPanel.vue';

enableAutoUnmount(afterEach);

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((accept, fail) => {
        resolve = accept;
        reject = fail;
    });
    return { promise, resolve, reject };
}

const emptyFiles: QuickSearchResult = {
    shortcuts: [],
    files: [],
    total_files: 0,
    total_results: 0,
    next_offset: 0,
};
const summary: SkillMetadata = {
    name: 'summary',
    description: 'Summarize a document',
    shortDescription: null,
    path: 'D:/skills/summary/SKILL.md',
    directory: 'D:/skills/summary',
};

beforeEach(() => {
    setLocale('zh-CN');
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
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('given a file query can complete without matching files', () => {
    it.each([
        { referenceMode: false, compact: false },
        { referenceMode: true, compact: false },
        { referenceMode: true, compact: true },
    ])(
        'user searches with $referenceMode reference mode in a compact=$compact surface then shows empty results only in the conversation picker',
        async ({ referenceMode, compact }) => {
            vi.useFakeTimers();
            const first = deferred<QuickSearchResult>();
            const second = deferred<QuickSearchResult>();
            mockTauriCommand('quick_search_search_shortcuts', (payload: unknown) =>
                (payload as { query: string }).query === 'missing' ? first.promise : second.promise
            );
            const query = ref('missing');
            const open = ref(false);
            const wrapper = mount(
                defineComponent({
                    setup: () => () =>
                        h(QuickSearchPanel, {
                            open: open.value,
                            searchQuery: query.value,
                            referenceMode,
                            compact,
                            'onUpdate:open': (value) => (open.value = value),
                        }),
                }),
                { global: { plugins: [createPinia()] } }
            );
            wrapper.getComponent(QuickSearchPanel).vm.triggerSearch(query.value);
            await vi.advanceTimersByTimeAsync(80);
            await flushPromises();
            expect(wrapper.text()).not.toContain('未找到匹配的文件');

            first.resolve(emptyFiles);
            await flushPromises();
            expect(open.value).toBe(compact);
            if (compact) expect(wrapper.get('[role="status"]').text()).toBe('未找到匹配的文件');
            else expect(wrapper.find('[data-testid="quick-search-panel"]').exists()).toBe(false);
            expect(wrapper.find('[data-slot="result-item"]').exists()).toBe(false);
            const surface = compact
                ? wrapper.get('[data-testid="quick-search-panel"]').element
                : null;

            query.value = 'report';
            await flushPromises();
            wrapper.getComponent(QuickSearchPanel).vm.triggerSearch(query.value);
            await vi.advanceTimersByTimeAsync(80);
            expect(wrapper.text()).not.toContain('未找到匹配的文件');
            if (compact)
                expect(wrapper.get('[data-testid="quick-search-panel"]').element).toBe(surface);
            else expect(wrapper.find('[data-testid="quick-search-panel"]').exists()).toBe(false);

            second.resolve({
                ...emptyFiles,
                files: [{ name: 'report.md', path: 'D:/report.md', source: 'file' }],
                total_files: 1,
                total_results: 1,
                next_offset: 1,
            });
            await flushPromises();
            expect(open.value).toBe(true);
            expect(wrapper.find('[role="status"]').exists()).toBe(false);
            expect(wrapper.text()).toContain('report.md');

            const next = deferred<QuickSearchResult>();
            mockTauriCommand('quick_search_search_shortcuts', () => next.promise);
            query.value = 'another-missing';
            await flushPromises();
            await vi.advanceTimersByTimeAsync(80);
            expect(open.value).toBe(true);
            expect(wrapper.text()).toContain('report.md');
            expect(wrapper.find('[role="status"]').exists()).toBe(false);
            next.resolve(emptyFiles);
            await flushPromises();
            expect(open.value).toBe(compact);
            expect(wrapper.find('[data-testid="quick-search-panel"]').exists()).toBe(compact);
        }
    );

    it.each(['missing', ''])(
        'user whose file query %j fails never sees a successful empty-result message',
        async (searchQuery) => {
            const unavailable = () => Promise.reject(new Error('Index unavailable'));
            mockTauriCommand('quick_search_search_shortcuts', unavailable);
            mockTauriCommand('quick_search_file_reference_suggestions', unavailable);
            const wrapper = mount(QuickSearchPanel, {
                props: { open: true, searchQuery, referenceMode: true },
                global: { plugins: [createPinia()] },
            });
            await flushPromises();
            expect(wrapper.text()).not.toContain('未找到匹配的文件');
        }
    );
});

describe('given a skill query can complete without matching skills', () => {
    it.each(['/', '$'])(
        'user searches with %s then sees an empty message after loading and keeps it hidden during a refresh',
        async (prefix) => {
            const first = deferred<SkillMetadata[]>();
            const refresh = deferred<SkillMetadata[]>();
            let reloading = false;
            let picker!: ReturnType<typeof useSkillAutocomplete>;
            const wrapper = mount(
                defineComponent({
                    setup() {
                        picker = useSkillAutocomplete({
                            discoverSkills: () => (reloading ? refresh.promise : first.promise),
                            getSelectedSkills: () => [],
                            onSelect: () => undefined,
                        });
                        return () =>
                            picker.isOpen.value
                                ? h(SkillPickerPanel, {
                                      compact: true,
                                      picker: {
                                          listId: 'skills-empty',
                                          query: picker.query.value,
                                          loading: picker.isLoading.value,
                                          error: picker.error.value,
                                          candidates: picker.candidates.value,
                                          highlightedIndex: picker.highlightedIndex.value,
                                      },
                                  })
                                : null;
                    },
                })
            );
            const loading = picker.refresh(`${prefix}missing`);
            await flushPromises();
            expect(wrapper.text()).not.toContain('未找到匹配的技能');
            first.resolve([summary]);
            await loading;
            await flushPromises();
            expect(wrapper.get('[role="status"]').text()).toBe('未找到匹配的技能');
            const surface = wrapper.get('[data-testid="skill-picker-panel"]').element;

            reloading = true;
            const requery = picker.refresh(`${prefix}missing`, { resume: true });
            await flushPromises();
            expect(wrapper.text()).not.toContain('未找到匹配的技能');
            expect(wrapper.get('[data-testid="skill-picker-panel"]').element).toBe(surface);
            refresh.resolve([summary]);
            await requery;
            await flushPromises();
            expect(wrapper.get('[role="status"]').text()).toBe('未找到匹配的技能');

            await picker.refresh(`${prefix}sum`);
            await flushPromises();
            expect(wrapper.find('[role="status"]').exists()).toBe(false);
            expect(wrapper.get('[role="option"]').text()).toContain('summary');
            picker.close();
            await flushPromises();
            expect(wrapper.find('[data-testid="skill-picker-panel"]').exists()).toBe(false);
        }
    );
});
