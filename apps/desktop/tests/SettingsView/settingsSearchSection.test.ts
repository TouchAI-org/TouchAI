import { DEFAULT_SEARCH_SETTINGS } from '@services/SettingsService/domain';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

import SearchSettingsView from '@/views/SettingsView/components/Search/index.vue';

const updateSearchSettingsMock = vi.hoisted(() =>
    vi.fn<(config: Record<string, unknown>) => Promise<void>>(async () => undefined)
);
const findBuiltInToolByToolIdMock = vi.hoisted(() => vi.fn());
const updateBuiltInToolMock = vi.hoisted(() => vi.fn());
const settingsRefHolder = vi.hoisted(() => ({
    current: null as null | { value: { searchSettings: Record<string, unknown> } },
}));

vi.mock('@/stores/settings', async () => {
    const { DEFAULT_SEARCH_SETTINGS } = await import('@services/SettingsService/domain');
    const { ref } = await import('vue');
    const settingsRef = ref({
        searchSettings: {
            ...DEFAULT_SEARCH_SETTINGS,
            defaultProvider: 'brave',
            maxResults: 8,
            providers: {
                ...DEFAULT_SEARCH_SETTINGS.providers,
                brave: { enabled: true, apiKey: 'brave-key' },
            },
        },
    });
    settingsRefHolder.current = settingsRef as unknown as {
        value: { searchSettings: Record<string, unknown> };
    };

    return {
        useSettingsStore: () => ({
            settings: settingsRef,
            updateSearchSettings: updateSearchSettingsMock,
        }),
    };
});

vi.mock('@database/queries', () => ({
    findBuiltInToolByToolId: findBuiltInToolByToolIdMock,
    updateBuiltInTool: updateBuiltInToolMock,
}));

function updateStoredSearchSettings(patch: Record<string, unknown>) {
    const holder = settingsRefHolder.current;
    if (!holder) {
        throw new Error('settings store was not initialized');
    }
    holder.value = {
        searchSettings: {
            ...holder.value.searchSettings,
            ...patch,
        },
    };
}

vi.mock('@components/CustomSelect.vue', () => ({
    default: {
        name: 'CustomSelect',
        props: ['modelValue', 'options', 'disabled'],
        emits: ['update:modelValue'],
        template:
            '<select data-testid="custom-select" :disabled="disabled" :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value)"><option v-for="option in options" :key="option.value" :value="option.value">{{ option.label }}</option></select>',
    },
}));

describe('user edits the search settings', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        vi.useFakeTimers();
        updateSearchSettingsMock.mockClear();
        updateSearchSettingsMock.mockImplementation(async (config: Record<string, unknown>) => {
            updateStoredSearchSettings(config);
        });
        updateBuiltInToolMock.mockClear();
        if (settingsRefHolder.current) {
            settingsRefHolder.current.value = {
                searchSettings: {
                    ...DEFAULT_SEARCH_SETTINGS,
                    defaultProvider: 'brave',
                    maxResults: 8,
                    providers: {
                        ...DEFAULT_SEARCH_SETTINGS.providers,
                        brave: { enabled: true, apiKey: 'brave-key' },
                    },
                },
            };
        }
        findBuiltInToolByToolIdMock.mockResolvedValue({
            id: 7,
            tool_id: 'web_search',
            display_name: 'WebSearch',
            description: null,
            enabled: 1,
            risk_level: 'low',
            config_json: null,
            last_used_at: null,
            created_at: '',
            updated_at: '',
        });
        updateBuiltInToolMock.mockImplementation(
            async (id: number, patch: { enabled?: number }) => ({
                id,
                tool_id: 'web_search',
                display_name: 'WebSearch',
                description: null,
                enabled: patch.enabled ?? 1,
                risk_level: 'low',
                config_json: null,
                last_used_at: null,
                created_at: '',
                updated_at: '',
            })
        );
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('user sees grouped providers and saves the result count without a submit button', async () => {
        const wrapper = mount(SearchSettingsView);
        await nextTick();
        expect(wrapper.findAll('[data-testid="search-provider-row"]')).toHaveLength(19);
        expect(wrapper.text()).toContain('通用检索');
        expect(wrapper.text()).toContain('中文内容');
        expect(wrapper.text()).toContain('知识与专业');
        expect(wrapper.text()).toContain('自建服务');
        expect(wrapper.findAll('[data-testid="search-provider-row"] img')).toHaveLength(19);
        expect(wrapper.find('[data-testid="search-brave-api-key-input"]').exists()).toBe(false);
        await wrapper.get('[data-testid="search-max-results-input"]').setValue('100');
        await vi.advanceTimersByTimeAsync(300);
        expect(updateSearchSettingsMock).toHaveBeenCalledWith(
            expect.objectContaining({ maxResults: 100 })
        );
        wrapper.unmount();
    });

    it('user edits a key in the slide editor and can go back without saving', async () => {
        const wrapper = mount(SearchSettingsView);
        await nextTick();
        const ids = () =>
            wrapper
                .findAll('[data-testid="search-provider-row"]')
                .map((row) => row.attributes('data-provider'));
        const before = ids();
        await wrapper.get('[data-testid="search-provider-edit-brave"]').trigger('click');
        expect(wrapper.findAll('[data-testid="search-provider-row"]')).toHaveLength(19);
        expect(wrapper.find('[data-testid="search-provider-editor"]').exists()).toBe(true);
        const input = wrapper.get('[data-testid="search-brave-api-key-input"]');
        expect(input.attributes('type')).toBe('password');
        await input.setValue('changed-key');
        await wrapper.get('[data-testid="search-provider-editor-back"]').trigger('click');
        await vi.advanceTimersByTimeAsync(300);
        expect(updateSearchSettingsMock).not.toHaveBeenCalled();
        expect(ids()).toEqual(before);
        await wrapper.get('[data-testid="search-provider-edit-brave"]').trigger('click');
        await wrapper.get('[data-testid="search-brave-api-key-input"]').setValue('saved-key');
        await wrapper.get('[data-testid="search-provider-editor-save"]').trigger('click');
        await vi.advanceTimersByTimeAsync(300);
        expect(updateSearchSettingsMock).toHaveBeenCalledWith(
            expect.objectContaining({
                providers: expect.objectContaining({
                    brave: expect.objectContaining({ apiKey: 'saved-key' }),
                }),
            })
        );
        expect(wrapper.find('[data-testid="search-provider-editor"]').exists()).toBe(false);
        wrapper.unmount();
    });

    it('user switches between key and base URL in the credential tabs', async () => {
        const wrapper = mount(SearchSettingsView);
        await nextTick();
        await wrapper.get('[data-testid="search-provider-edit-qianfan"]').trigger('click');
        await wrapper.get('[data-testid="search-qianfan-api-key-input"]').setValue('q-key');
        const tabs = wrapper.get('[data-testid="search-provider-credential-tabs"]');
        await tabs.findAll('button')[1]!.trigger('click');
        const endpoint = wrapper.get('[data-testid="search-qianfan-base-url-input"]');
        await endpoint.setValue('https://qianfan.example.com/v1');
        await wrapper.get('[data-testid="search-provider-editor-save"]').trigger('click');
        await vi.advanceTimersByTimeAsync(300);
        expect(updateSearchSettingsMock).toHaveBeenCalledWith(
            expect.objectContaining({
                providers: expect.objectContaining({
                    qianfan: expect.objectContaining({
                        apiKey: 'q-key',
                        endpoint: 'https://qianfan.example.com/v1',
                    }),
                }),
            })
        );
        wrapper.unmount();
    });

    it('user can configure a disabled engine in the editor and enable it afterwards', async () => {
        const wrapper = mount(SearchSettingsView);
        await nextTick();
        await wrapper.get('[data-testid="search-provider-edit-deepseek"]').trigger('click');
        const input = wrapper.get('[data-testid="search-deepseek-api-key-input"]');
        await input.setValue('ds-key');
        await wrapper.get('[data-testid="search-provider-editor-save"]').trigger('click');
        await wrapper.get('[data-testid="search-provider-toggle-deepseek"]').trigger('click');
        await vi.advanceTimersByTimeAsync(300);
        expect(updateSearchSettingsMock).toHaveBeenCalledWith(
            expect.objectContaining({
                providers: expect.objectContaining({
                    deepseek: expect.objectContaining({ enabled: true, apiKey: 'ds-key' }),
                }),
            })
        );
        wrapper.unmount();
    });

    it('user is sent to the editor when enabling an engine without its key', async () => {
        const wrapper = mount(SearchSettingsView);
        await nextTick();
        const toggle = () => wrapper.get('[data-testid="search-provider-toggle-deepseek"]');
        await toggle().trigger('click');
        expect(wrapper.find('[data-testid="search-provider-editor"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="search-provider-toggle-deepseek"]').exists()).toBe(
            false
        );
        await wrapper.get('[data-testid="search-provider-editor-back"]').trigger('click');
        await nextTick();
        expect(wrapper.find('[data-testid="search-provider-editor"]').exists()).toBe(false);
        expect(toggle().attributes('aria-checked')).toBe('false');

        await toggle().trigger('click');
        await wrapper.get('[data-testid="search-deepseek-api-key-input"]').setValue('ds-key');
        await wrapper.get('[data-testid="search-provider-editor-save"]').trigger('click');
        await nextTick();
        expect(toggle().attributes('aria-checked')).toBe('true');
        await vi.advanceTimersByTimeAsync(300);
        expect(updateSearchSettingsMock).toHaveBeenLastCalledWith(
            expect.objectContaining({
                providers: expect.objectContaining({
                    deepseek: expect.objectContaining({ enabled: true, apiKey: 'ds-key' }),
                }),
            })
        );
        wrapper.unmount();
    });

    it('user can choose one of three strategies, enable fusion and configure routing', async () => {
        const wrapper = mount(SearchSettingsView);
        await nextTick();
        expect(wrapper.findAll('[data-testid^="search-strategy-"]')).toHaveLength(3);
        await wrapper.get('[data-testid="search-source-route-academic"]').setValue('exa');
        await wrapper.get('[data-testid="search-strategy-priority"]').trigger('click');
        await nextTick();
        const priority = wrapper.get('[data-testid="search-provider-priority"]');
        await wrapper.get('[data-testid="search-priority-top-tavily"]').trigger('click');
        await wrapper.get('[data-testid="search-parallel-toggle"]').trigger('click');
        await wrapper.get('[data-testid="search-parallel-count-input"]').setValue('5');
        await vi.advanceTimersByTimeAsync(300);
        expect(updateSearchSettingsMock).toHaveBeenLastCalledWith(
            expect.objectContaining({
                routingStrategy: 'priority',
                parallelProviders: true,
                parallelProviderCount: 5,
                providerPriority: expect.arrayContaining(['keenable', 'anysearch']),
                sourceRoutes: expect.objectContaining({ academic: 'exa' }),
            })
        );
        expect(priority.findAll('li')[0]!.attributes('data-provider')).toBe('tavily');
        wrapper.unmount();
    });

    it('user can exclude an engine from content fetching', async () => {
        const wrapper = mount(SearchSettingsView);
        await nextTick();
        await wrapper.get('[data-testid="search-provider-edit-exa"]').trigger('click');
        const tabs = wrapper.get('[data-testid="search-provider-credential-tabs"]');
        await tabs.findAll('button')[2]!.trigger('click');
        const toggle = wrapper.get('[data-testid="search-provider-fetch-toggle-exa"]');
        expect(toggle.attributes('aria-checked')).toBe('true');
        await toggle.trigger('click');
        await vi.advanceTimersByTimeAsync(300);
        expect(updateSearchSettingsMock).toHaveBeenLastCalledWith(
            expect.objectContaining({
                providers: expect.objectContaining({
                    exa: expect.objectContaining({ fetchEnabled: false }),
                }),
            })
        );
        wrapper.unmount();
    });

    it('user does not see fusion when a fixed default engine is selected', async () => {
        const wrapper = mount(SearchSettingsView);
        await nextTick();
        await wrapper.get('[data-testid="search-parallel-toggle"]').trigger('click');
        expect(wrapper.find('[data-testid="search-parallel-count-input"]').exists()).toBe(true);
        await wrapper.get('[data-testid="search-strategy-manual"]').trigger('click');
        await nextTick();
        expect(wrapper.find('[data-testid="search-parallel-toggle"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="search-parallel-count-input"]').exists()).toBe(false);
        await vi.advanceTimersByTimeAsync(300);
        expect(updateSearchSettingsMock).toHaveBeenLastCalledWith(
            expect.objectContaining({ routingStrategy: 'manual', parallelProviders: false })
        );
        wrapper.unmount();
    });

    it('user clears source routes when disabling an engine without moving its card', async () => {
        const wrapper = mount(SearchSettingsView);
        await nextTick();
        const ids = () =>
            wrapper
                .findAll('[data-testid="search-provider-row"]')
                .map((row) => row.attributes('data-provider'));
        const before = ids();
        await wrapper.get('[data-testid="search-source-route-news"]').setValue('brave');
        await wrapper.get('[data-testid="search-provider-toggle-brave"]').trigger('click');
        await vi.advanceTimersByTimeAsync(300);
        expect(updateSearchSettingsMock).toHaveBeenLastCalledWith(
            expect.objectContaining({ sourceRoutes: expect.objectContaining({ news: 'auto' }) })
        );
        expect(ids()).toEqual(before);
        wrapper.unmount();
    });

    it('user toggles academic engines and immediately sees specialist then general replacements', async () => {
        const wrapper = mount(SearchSettingsView);
        await nextTick();
        const route = () => wrapper.get('[data-testid="search-source-route-academic"]');
        expect(route().attributes('aria-label')).toContain('OpenAlex');
        await wrapper.get('[data-testid="search-provider-toggle-openalex"]').trigger('click');
        expect(route().attributes('aria-label')).toContain('Semantic Scholar');
        await wrapper
            .get('[data-testid="search-provider-toggle-semantic_scholar"]')
            .trigger('click');
        expect(route().attributes('aria-label')).toContain('Brave');
        await wrapper.get('[data-testid="search-provider-toggle-brave"]').trigger('click');
        expect(route().attributes('aria-label')).toContain('AnySearch');
        await wrapper.get('[data-testid="search-provider-toggle-openalex"]').trigger('click');
        expect(route().attributes('aria-label')).toContain('OpenAlex');
        wrapper.unmount();
    });

    it('user keeps a chosen route when another specialist becomes available', async () => {
        const wrapper = mount(SearchSettingsView);
        await nextTick();
        await wrapper.get('[data-testid="search-source-route-academic"]').setValue('exa');
        await wrapper.get('[data-testid="search-provider-toggle-openalex"]').trigger('click');
        await wrapper.get('[data-testid="search-provider-toggle-openalex"]').trigger('click');
        expect(
            wrapper.get('[data-testid="search-source-route-academic"]').attributes('aria-label')
        ).toContain('Exa');
        wrapper.unmount();
    });

    it('user disables all engines and sees an unavailable route instead of a disabled recommendation', async () => {
        updateStoredSearchSettings({
            providers: Object.fromEntries(
                Object.entries(DEFAULT_SEARCH_SETTINGS.providers).map(([id, config]) => [
                    id,
                    { ...config, enabled: false },
                ])
            ),
        });
        const wrapper = mount(SearchSettingsView);
        await nextTick();
        expect(
            wrapper.get('[data-testid="search-source-route-academic"]').attributes('aria-label')
        ).toContain('暂无可用引擎');
        wrapper.unmount();
    });

    it('user keeps a pending edit without reverting another window search change', async () => {
        const wrapper = mount(SearchSettingsView);
        await nextTick();
        await wrapper.get('[data-testid="search-max-results-input"]').setValue('5');
        updateStoredSearchSettings({ maxResults: 9, defaultProvider: 'wikipedia' });
        await nextTick();
        await vi.advanceTimersByTimeAsync(300);
        expect(updateSearchSettingsMock).toHaveBeenCalledWith(
            expect.objectContaining({ maxResults: 5, defaultProvider: 'wikipedia' })
        );
        wrapper.unmount();
    });

    it('user toggles the search tool and disables editing controls', async () => {
        const wrapper = mount(SearchSettingsView);
        await nextTick();
        await wrapper.get('[data-testid="search-enabled-toggle"]').trigger('click');
        expect(updateBuiltInToolMock).toHaveBeenCalledWith(7, { enabled: 0 });
        await nextTick();
        expect(
            (wrapper.get('[data-testid="search-provider-edit-brave"]').element as HTMLButtonElement)
                .disabled
        ).toBe(true);
        wrapper.unmount();
    });

    it('user enables anonymous engines without a key and configures optional tokens for academic and code search', async () => {
        const wrapper = mount(SearchSettingsView);
        await nextTick();
        for (const provider of ['tavily', 'exa', 'firecrawl']) {
            await wrapper
                .get('[data-testid="search-provider-toggle-' + provider + '"]')
                .trigger('click');
            await wrapper
                .get('[data-testid="search-provider-toggle-' + provider + '"]')
                .trigger('click');
            expect(
                wrapper
                    .get('[data-testid="search-provider-toggle-' + provider + '"]')
                    .attributes('aria-checked')
            ).toBe('true');
        }
        expect(wrapper.find('[data-testid="search-provider-edit-wikipedia"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="search-provider-edit-openalex"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="search-provider-edit-github"]').exists()).toBe(true);
        wrapper.unmount();
    });
});
