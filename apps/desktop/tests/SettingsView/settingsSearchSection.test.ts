import { createSettingsPanelFixture, openSettingsSelect } from '@tests/utils/settingsPanel';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_SEARCH_SETTINGS, parseSearchSettingsConfig } from '@/app/api/settings/tools';
import SearchSettingsView from '@/views/SettingsView/components/Search/index.vue';

let fixture: Awaited<ReturnType<typeof createSettingsPanelFixture>>;
let wrapper: VueWrapper | undefined;
let pauseWrite: (() => Promise<void>) | undefined;

beforeEach(async () => {
    pauseWrite = undefined;
    vi.useFakeTimers();
    vi.stubGlobal(
        'ResizeObserver',
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        }
    );
    fixture = await createSettingsPanelFixture({
        query: {
            async beforeQuery({ sql, params }) {
                if (sql.startsWith('insert') && params[0] === 'search_settings')
                    await pauseWrite?.();
            },
        },
        values: {
            language: 'en-US',
            search_settings: JSON.stringify({
                ...DEFAULT_SEARCH_SETTINGS,
                defaultProvider: 'brave',
                maxResults: 8,
                providers: {
                    ...DEFAULT_SEARCH_SETTINGS.providers,
                    brave: { enabled: true, apiKey: 'brave-key' },
                },
            }),
        },
    });
});

afterEach(async () => {
    wrapper?.unmount();
    wrapper = undefined;
    await fixture.dispose();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
});

async function openPanel() {
    wrapper = mount(SearchSettingsView, fixture.viewOptions);
    await flushPromises();
    return wrapper;
}
const saved = () => parseSearchSettingsConfig(fixture.saved('search_settings') ?? null);
async function settleSave() {
    await vi.advanceTimersByTimeAsync(300);
    await flushPromises();
}

describe('given search configuration belongs to the main tools owner', () => {
    it('user sees dedicated controls and saves a result limit without exposing the saved credential', async () => {
        const panel = await openPanel();
        expect(panel.get('[data-testid="search-settings-title"]').text()).toContain('Search');
        expect(panel.findAll('[data-testid^="search-advanced-toggle-"]')).toHaveLength(3);
        expect(panel.get('[data-testid="search-max-results-input"]').element).toMatchObject({
            value: '8',
        });
        expect(panel.get('[data-testid="search-brave-api-key-input"]').element).toMatchObject({
            value: 'brave-key',
        });
        expect(panel.get('[data-testid="search-brave-api-key-input"]').attributes('type')).toBe(
            'password'
        );
        expect(
            panel.findAll('[data-testid="search-provider-row"]').map((row) => row.text())
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
            expect.stringContaining('DeepSeek'),
        ]);
        expect(panel.get('[data-testid="search-provider-quota-brave"]').text()).toContain('2k');
        expect(
            panel.get('[data-testid="search-provider-quota-semantic_scholar"]').text()
        ).toContain('1 RPS');
        expect(panel.find('[data-testid="search-save-button"]').exists()).toBe(false);
        await panel.get('[data-testid="search-max-results-input"]').setValue('5');
        await settleSave();
        expect(saved().maxResults).toBe(5);
        expect(JSON.stringify(fixture.client.settings.getSnapshot())).not.toContain('brave-key');
    });

    it('user disables web search through its settings switch and main commits that choice', async () => {
        const panel = await openPanel();
        await panel.get('[data-testid="search-enabled-toggle"]').trigger('click');
        await flushPromises();
        expect(
            fixture.database
                .prepare("SELECT enabled FROM built_in_tools WHERE tool_id = 'web_search'")
                .get()
        ).toEqual({ enabled: 0 });
        expect(panel.get('[data-testid="search-enabled-toggle"]').attributes('aria-checked')).toBe(
            'false'
        );
    });

    it('user keeps a pending result limit while incorporating another window provider choice', async () => {
        const panel = await openPanel();
        await panel.get('[data-testid="search-max-results-input"]').setValue('5');
        const incoming = fixture.window.toolSettings!.getSearchSettings();
        await fixture.window.toolSettings!.updateSearchSettings({
            ...incoming,
            maxResults: 9,
            defaultProvider: 'wikipedia',
        });
        await flushPromises();
        await settleSave();
        expect(saved()).toMatchObject({ maxResults: 5, defaultProvider: 'wikipedia' });
    });

    it('user changes an advanced switch and sees its persisted value on the same control', async () => {
        const panel = await openPanel();
        const toggle = panel.get('[data-testid="search-advanced-toggle-parallelProviders"]');
        expect(toggle.attributes('role')).toBe('switch');
        expect(toggle.attributes('aria-checked')).toBe('false');
        await toggle.trigger('click');
        await settleSave();
        expect(saved().parallelProviders).toBe(true);
        expect(toggle.attributes('aria-checked')).toBe('true');
    });

    it('user selects only enabled route providers and disabling one resets its saved routes', async () => {
        const panel = await openPanel();
        const route = panel.findAll('[role="combobox"]')[1]!;
        const options = await openSettingsSelect(route);
        const labels = options.map((option) => option.text());
        expect(labels).toEqual(
            expect.arrayContaining(['Auto', 'Brave Search', 'Tavily', 'Exa', 'Firecrawl'])
        );
        expect(labels).not.toContain('SearXNG');
        options
            .find((option) => option.text() === 'Brave Search')!
            .element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
        await flushPromises();
        await panel.get('[data-testid="search-provider-toggle-brave"]').trigger('click');
        await settleSave();
        expect(saved()).toMatchObject({
            providers: { brave: { enabled: false } },
            intentRoutes: { general: 'auto' },
        });
    });

    it('user re-enables an optional-key provider without inventing a credential', async () => {
        const panel = await openPanel();
        for (const provider of ['tavily', 'exa', 'firecrawl']) {
            expect(
                panel
                    .get(`[data-testid="search-provider-toggle-${provider}"]`)
                    .attributes('aria-checked')
            ).toBe('true');
            expect(
                panel.get(`[data-testid="search-${provider}-api-key-input"]`).classes()
            ).not.toContain('border-red-300');
        }
        await panel.get('[data-testid="search-provider-toggle-tavily"]').trigger('click');
        await settleSave();
        expect(saved().providers.tavily.enabled).toBe(false);
        await panel.get('[data-testid="search-provider-toggle-tavily"]').trigger('click');
        await settleSave();
        expect(saved().providers.tavily).toMatchObject({ enabled: true, apiKey: '' });
    });

    it('user supplies a required credential before DeepSeek becomes enabled', async () => {
        const panel = await openPanel();
        expect(
            panel.get('[data-testid="search-deepseek-api-key-input"]').attributes('disabled')
        ).toBeDefined();
        await panel.get('[data-testid="search-provider-toggle-deepseek"]').trigger('click');
        await settleSave();
        expect(saved().providers.deepseek.enabled).toBe(false);
        expect(panel.get('[data-testid="search-deepseek-api-key-input"]').classes()).toContain(
            'border-red-300'
        );
        expect(
            panel.get('[data-testid="search-deepseek-api-key-input"]').attributes('disabled')
        ).toBeUndefined();
        await panel.get('[data-testid="search-deepseek-api-key-input"]').setValue('ds-key');
        await settleSave();
        await panel.get('[data-testid="search-provider-toggle-deepseek"]').trigger('click');
        await settleSave();
        expect(saved().providers.deepseek).toMatchObject({ enabled: true, apiKey: 'ds-key' });
        expect(panel.find('[data-testid="search-deepseek-shared-credential-hint"]').exists()).toBe(
            false
        );
    });

    it('user cannot edit credentials for providers that do not accept them', async () => {
        const panel = await openPanel();
        for (const provider of ['wikipedia', 'openalex', 'github', 'searxng']) {
            expect(
                panel.get(`[data-testid="search-${provider}-api-key-input"]`).attributes('disabled')
            ).toBeDefined();
        }
        for (const provider of ['brave', 'semantic_scholar', 'anysearch']) {
            expect(
                panel.get(`[data-testid="search-${provider}-api-key-input"]`).attributes('disabled')
            ).toBeUndefined();
        }
        expect(panel.get('[data-testid="search-searxng-api-key-input"]').attributes('type')).toBe(
            'url'
        );
    });

    it('user loses main administration and the unavailable tool switch cannot pretend to commit a choice', async () => {
        await fixture.window.dispose();
        const panel = await openPanel();
        await vi.advanceTimersByTimeAsync(5_000);
        await flushPromises();
        expect(
            panel.get('[data-testid="search-enabled-toggle"]').attributes('disabled')
        ).toBeDefined();
        expect(
            fixture.database
                .prepare("SELECT enabled FROM built_in_tools WHERE tool_id = 'web_search'")
                .get()
        ).toEqual({ enabled: 1 });
    });

    it('user closes during a save and no later draft edit is submitted by the detached panel', async () => {
        const panel = await openPanel();
        let entered!: () => void;
        let release!: () => void;
        const writing = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const barrier = new Promise<void>((resolve) => {
            release = resolve;
        });
        pauseWrite = async () => {
            entered();
            await barrier;
        };
        await panel.get('[data-testid="search-max-results-input"]').setValue('5');
        await vi.advanceTimersByTimeAsync(300);
        await writing;
        await panel.get('[data-testid="search-max-results-input"]').setValue('4');
        panel.unmount();
        wrapper = undefined;
        pauseWrite = undefined;
        release();
        await flushPromises();
        await settleSave();
        expect(saved().maxResults).toBe(5);
    });
});
