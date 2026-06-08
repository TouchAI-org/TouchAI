import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import SearchSettingsView from '@/views/SettingsView/components/Search/index.vue';

const updateSearchSettingsMock = vi.hoisted(() => vi.fn(async () => undefined));
const findBuiltInToolByToolIdMock = vi.hoisted(() => vi.fn());
const updateBuiltInToolMock = vi.hoisted(() => vi.fn());

vi.mock('@/stores/settings', async () => {
    const { DEFAULT_SEARCH_SETTINGS } = await import('@/config/searchSettings');
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

vi.mock('@components/CustomSelect.vue', () => ({
    default: {
        name: 'CustomSelect',
        props: ['modelValue', 'options', 'disabled'],
        emits: ['update:modelValue'],
        template:
            '<select data-testid="custom-select" :disabled="disabled" :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value)"><option v-for="option in options" :key="option.value" :value="option.value">{{ option.label }}</option></select>',
    },
}));

describe('Search settings section', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        vi.useFakeTimers();
        updateSearchSettingsMock.mockClear();
        updateBuiltInToolMock.mockClear();
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
        updateBuiltInToolMock.mockImplementation(async (id: number, patch: { enabled?: number }) => ({
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
        }));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('renders dedicated search controls using browser-settings style and auto-saves edits', async () => {
        const wrapper = mount(SearchSettingsView);
        await Promise.resolve();

        expect(wrapper.get('[data-testid="search-settings-title"]').text()).toContain('搜索');
        expect(wrapper.get('[data-testid="search-enabled-toggle"]')).toBeTruthy();
        expect(wrapper.text()).toContain('管理 TouchAI 搜索资料来源和路由策略');
        expect(wrapper.text()).toContain('基础');
        expect(wrapper.text()).toContain('服务商');
        expect(wrapper.text()).toContain('路由策略');
        expect(wrapper.text()).toContain('高级');
        expect(wrapper.findAll('input[type="checkbox"]')).toHaveLength(0);
        expect(wrapper.findAll('[data-testid^="search-advanced-toggle-"]')).toHaveLength(3);
        expect(wrapper.get('[data-testid="search-max-results-input"]').element).toMatchObject({
            value: '8',
        });
        expect(wrapper.get('[data-testid="search-brave-api-key-input"]').element).toMatchObject({
            value: 'brave-key',
        });
        expect(wrapper.get('[data-testid="search-brave-api-key-input"]').attributes('type')).toBe(
            'password'
        );
        expect(
            wrapper.findAll('[data-testid="search-provider-row"]').map((row) => row.text())
        ).toEqual([
            expect.stringContaining('AnySearch'),
            expect.stringContaining('Wikipedia'),
            expect.stringContaining('OpenAlex'),
            expect.stringContaining('Semantic Scholar'),
            expect.stringContaining('GitHub'),
            expect.stringContaining('Brave Search'),
            expect.stringContaining('Tavily'),
            expect.stringContaining('Exa'),
            expect.stringContaining('Firecrawl'),
            expect.stringContaining('SearXNG'),
        ]);
        expect(wrapper.get('[data-testid="search-provider-quota-brave"]').classes()).toContain(
            'rounded'
        );
        expect(wrapper.get('[data-testid="search-provider-quota-brave"]').text()).toContain(
            '2k'
        );
        expect(wrapper.get('[data-testid="search-provider-quota-tavily"]').text()).toContain(
            '1k'
        );
        expect(wrapper.get('[data-testid="search-provider-quota-anysearch"]').text()).not.toBe(
            '免费'
        );
        expect(wrapper.get('[data-testid="search-provider-quota-semantic_scholar"]').text()).toContain(
            '1 RPS'
        );
        expect(wrapper.find('[data-testid="search-save-button"]').exists()).toBe(false);

        await wrapper.get('[data-testid="search-max-results-input"]').setValue('5');
        await vi.advanceTimersByTimeAsync(300);

        expect(updateSearchSettingsMock).toHaveBeenCalledWith(
            expect.objectContaining({ maxResults: 5 })
        );
    });

    it('toggles the web_search built-in tool from the search tab', async () => {
        const wrapper = mount(SearchSettingsView);
        await Promise.resolve();

        await wrapper.get('[data-testid="search-enabled-toggle"]').trigger('click');

        expect(updateBuiltInToolMock).toHaveBeenCalledWith(7, { enabled: 0 });
    });

    it('uses compact switch controls for advanced boolean settings', async () => {
        const wrapper = mount(SearchSettingsView);
        await Promise.resolve();

        const parallelToggle = wrapper.get('[data-testid="search-advanced-toggle-parallelProviders"]');
        expect(parallelToggle.attributes('aria-pressed')).toBe('false');
        expect(parallelToggle.classes()).toContain('bg-neutral-200');

        await parallelToggle.trigger('click');
        await vi.advanceTimersByTimeAsync(300);

        expect(updateSearchSettingsMock).toHaveBeenCalledWith(
            expect.objectContaining({ parallelProviders: true })
        );
    });

    it('only shows enabled providers in routing and resets routes when a provider is disabled', async () => {
        const wrapper = mount(SearchSettingsView);
        await Promise.resolve();

        const routeSelect = wrapper.findAll('[data-testid="custom-select"]')[1];
        expect(routeSelect).toBeDefined();
        expect(routeSelect!.text()).toContain('自动');
        expect(routeSelect!.text()).toContain('AnySearch');
        expect(routeSelect!.text()).toContain('Wikipedia');
        expect(routeSelect!.text()).toContain('OpenAlex');
        expect(routeSelect!.text()).toContain('Semantic Scholar');
        expect(routeSelect!.text()).toContain('GitHub');
        expect(routeSelect!.text()).toContain('Brave Search');
        expect(routeSelect!.text()).not.toContain('Tavily');
        expect(routeSelect!.text()).not.toContain('Exa');
        expect(routeSelect!.text()).not.toContain('Firecrawl');
        expect(routeSelect!.text()).not.toContain('SearXNG');

        await routeSelect!.setValue('brave');
        await wrapper.get('[data-testid="search-provider-toggle-brave"]').trigger('click');
        await vi.advanceTimersByTimeAsync(300);

        expect(updateSearchSettingsMock).toHaveBeenCalledWith(
            expect.objectContaining({
                providers: expect.objectContaining({
                    brave: expect.objectContaining({ enabled: false }),
                }),
                intentRoutes: expect.objectContaining({
                    general: 'auto',
                }),
            })
        );
    });

    it('keeps required-key providers disabled until an API key is configured', async () => {
        const wrapper = mount(SearchSettingsView);
        await Promise.resolve();
        updateSearchSettingsMock.mockClear();

        const tavilyInput = wrapper.get('[data-testid="search-tavily-api-key-input"]');
        expect((tavilyInput.element as HTMLInputElement).disabled).toBe(true);
        expect(tavilyInput.classes()).not.toContain('border-red-300');
        expect(wrapper.find('[data-testid="search-provider-api-key-required-tavily"]').exists()).toBe(
            false
        );

        await wrapper.get('[data-testid="search-provider-toggle-tavily"]').trigger('click');
        await vi.advanceTimersByTimeAsync(300);

        expect(wrapper.get('[data-testid="search-provider-toggle-tavily"]').attributes('aria-pressed')).toBe(
            'false'
        );
        expect(wrapper.get('[data-testid="search-tavily-api-key-input"]').classes()).toContain(
            'border-red-300'
        );
        expect(
            (wrapper.get('[data-testid="search-tavily-api-key-input"]').element as HTMLInputElement)
                .disabled
        ).toBe(false);
        expect(wrapper.find('[data-testid="search-provider-api-key-required-tavily"]').exists()).toBe(
            false
        );
        expect(updateSearchSettingsMock).not.toHaveBeenCalledWith(
            expect.objectContaining({
                providers: expect.objectContaining({
                    tavily: expect.objectContaining({ enabled: true }),
                }),
            })
        );

        await tavilyInput.setValue('tavily-key');
        await vi.advanceTimersByTimeAsync(300);
        expect(wrapper.get('[data-testid="search-tavily-api-key-input"]').classes()).not.toContain(
            'border-red-300'
        );
        updateSearchSettingsMock.mockClear();

        await wrapper.get('[data-testid="search-provider-toggle-tavily"]').trigger('click');
        await vi.advanceTimersByTimeAsync(300);

        expect(updateSearchSettingsMock).toHaveBeenCalledWith(
            expect.objectContaining({
                providers: expect.objectContaining({
                    tavily: expect.objectContaining({ enabled: true, apiKey: 'tavily-key' }),
                }),
            })
        );
    });

    it('keeps no-key provider inputs disabled even when the providers are enabled', async () => {
        const wrapper = mount(SearchSettingsView);
        await Promise.resolve();

        expect((wrapper.get('[data-testid="search-wikipedia-api-key-input"]').element as HTMLInputElement).disabled).toBe(
            true
        );
        expect((wrapper.get('[data-testid="search-openalex-api-key-input"]').element as HTMLInputElement).disabled).toBe(
            true
        );
        expect((wrapper.get('[data-testid="search-github-api-key-input"]').element as HTMLInputElement).disabled).toBe(
            true
        );
        expect((wrapper.get('[data-testid="search-brave-api-key-input"]').element as HTMLInputElement).disabled).toBe(
            false
        );
        expect((wrapper.get('[data-testid="search-semantic_scholar-api-key-input"]').element as HTMLInputElement).disabled).toBe(
            false
        );
        expect((wrapper.get('[data-testid="search-anysearch-api-key-input"]').element as HTMLInputElement).disabled).toBe(
            false
        );
        expect((wrapper.get('[data-testid="search-searxng-api-key-input"]').element as HTMLInputElement).disabled).toBe(
            true
        );
        expect(wrapper.get('[data-testid="search-searxng-api-key-input"]').classes()).toContain(
            'font-serif'
        );
        expect(wrapper.get('[data-testid="search-searxng-api-key-input"]').classes()).toContain(
            'bg-[#f0f0ef]'
        );
    });
});
