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
    it('user sees grouped cards and saves an unlimited result count without exposing credentials', async () => {
        const panel = await openPanel();
        expect(panel.get('[data-testid="search-settings-title"]').text()).toContain('Search');
        expect(panel.findAll('[data-testid="search-provider-row"]')).toHaveLength(19);
        expect(panel.findAll('[data-testid^="search-strategy-"]')).toHaveLength(3);
        expect(
            panel.get('[data-testid="search-max-results-input"]').attributes('placeholder')
        ).toBe('Unlimited');
        expect(panel.find('[data-testid="search-brave-api-key-input"]').exists()).toBe(false);
        await panel.get('[data-testid="search-provider-edit-brave"]').trigger('click');
        expect(panel.get('[data-testid="search-brave-api-key-input"]').attributes('type')).toBe(
            'password'
        );
        await panel.get('[data-testid="search-provider-editor-back"]').trigger('click');
        await panel.get('[data-testid="search-max-results-input"]').setValue('0');
        await settleSave();
        expect(saved().maxResults).toBe(0);
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
            timeoutMs: 30000,
        });
        await flushPromises();
        await settleSave();
        await vi.advanceTimersByTimeAsync(1000);
        await flushPromises();
        expect(saved()).toMatchObject({
            maxResults: 5,
            defaultProvider: 'wikipedia',
            timeoutMs: 30000,
        });
        expect(
            panel.get('[data-settings-search-target="search-timeout"] input').element
        ).toMatchObject({ value: '30000' });
    });

    it('user changes an advanced switch and sees its persisted value on the same control', async () => {
        const panel = await openPanel();
        const toggle = panel.get('[data-testid="search-parallel-toggle"]');
        expect(toggle.attributes('role')).toBe('switch');
        expect(toggle.attributes('aria-checked')).toBe('false');
        await toggle.trigger('click');
        await settleSave();
        expect(saved().parallelProviders).toBe(true);
        expect(toggle.attributes('aria-checked')).toBe('true');
    });

    it('user selects only enabled route providers and disabling one resets its saved routes', async () => {
        const panel = await openPanel();
        const route = panel.get('[data-testid="search-source-route-general"]');
        const options = await openSettingsSelect(route);
        const labels = options.map((option) => option.text());
        expect(labels).toEqual(
            expect.arrayContaining(['Brave Search', 'Tavily', 'Exa', 'Firecrawl'])
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
            sourceRoutes: { general: 'auto' },
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
        await panel.get('[data-testid="search-provider-toggle-deepseek"]').trigger('click');
        expect(panel.find('[data-testid="search-provider-editor"]').exists()).toBe(true);
        expect(saved().providers.deepseek.enabled).toBe(false);
        await panel.get('[data-testid="search-deepseek-api-key-input"]').setValue('ds-key');
        await panel.get('[data-testid="search-provider-editor-save"]').trigger('click');
        await settleSave();
        expect(saved().providers.deepseek).toMatchObject({ enabled: true, apiKey: 'ds-key' });
    });

    it.each(['anysearch', 'deepseek', 'exa'] as const)(
        'user excludes and re-enables %s for page reading through its existing card',
        async (provider) => {
            const panel = await openPanel();
            await panel.get(`[data-testid="search-provider-edit-${provider}"]`).trigger('click');
            const tabs = panel.get('[data-testid="search-provider-credential-tabs"]');
            const buttons = tabs.findAll('button');
            await buttons[buttons.length - 1]!.trigger('click');
            await panel
                .get(`[data-testid="search-provider-fetch-toggle-${provider}"]`)
                .trigger('click');
            await settleSave();
            expect(saved().providers[provider].fetchEnabled).toBe(false);
            await panel
                .get(`[data-testid="search-provider-fetch-toggle-${provider}"]`)
                .trigger('click');
            await settleSave();
            expect(saved().providers[provider].fetchEnabled).not.toBe(false);
        }
    );

    it.each(['apiKey', 'endpoint'] as const)(
        'user edits %s while retaining another window changes to the other credential field',
        async (field) => {
            const panel = await openPanel();
            await panel.get('[data-testid="search-provider-edit-qianfan"]').trigger('click');
            const other = field === 'apiKey' ? 'endpoint' : 'apiKey';
            const incoming = fixture.window.toolSettings!.getSearchSettings();
            await fixture.window.toolSettings!.updateSearchSettings({
                ...incoming,
                providers: {
                    ...incoming.providers,
                    qianfan: { ...incoming.providers.qianfan, [other]: 'https://incoming.test' },
                },
            });
            await flushPromises();
            if (field === 'endpoint') {
                await panel
                    .get('[data-testid="search-provider-credential-tabs"]')
                    .findAll('button')[1]!
                    .trigger('click');
            }
            const selector = field === 'apiKey' ? 'api-key' : 'base-url';
            await panel
                .get(`[data-testid="search-qianfan-${selector}-input"]`)
                .setValue('https://local.test');
            await panel.get('[data-testid="search-provider-editor-save"]').trigger('click');
            await settleSave();
            expect(saved().providers.qianfan).toMatchObject({
                [field]: 'https://local.test',
                [other]: 'https://incoming.test',
            });
        }
    );

    it('user keeps a local draft when another window updates both credential fields afterwards', async () => {
        const panel = await openPanel();
        await panel.get('[data-testid="search-provider-edit-qianfan"]').trigger('click');
        await panel.get('[data-testid="search-qianfan-api-key-input"]').setValue('local-key');
        const incoming = fixture.window.toolSettings!.getSearchSettings();
        await fixture.window.toolSettings!.updateSearchSettings({
            ...incoming,
            providers: {
                ...incoming.providers,
                qianfan: {
                    ...incoming.providers.qianfan,
                    apiKey: 'incoming-key',
                    endpoint: 'https://incoming.test',
                },
            },
        });
        await flushPromises();
        await panel.get('[data-testid="search-provider-editor-save"]').trigger('click');
        await settleSave();
        expect(saved().providers.qianfan).toMatchObject({
            apiKey: 'local-key',
            endpoint: 'https://incoming.test',
        });
    });

    it('user edits credentials in place, cancels drafts, and saves both key and gateway', async () => {
        const panel = await openPanel();
        const order = () =>
            panel
                .findAll('[data-testid="search-provider-row"]')
                .map((row) => row.attributes('data-provider'));
        const original = order();
        await panel.get('[data-testid="search-provider-edit-brave"]').trigger('click');
        await panel.get('[data-testid="search-brave-api-key-input"]').setValue('cancelled-key');
        await panel.get('[data-testid="search-provider-editor-back"]').trigger('click');
        await settleSave();
        expect(saved().providers.brave.apiKey).not.toBe('cancelled-key');
        expect(order()).toEqual(original);
        await panel.get('[data-testid="search-provider-edit-qianfan"]').trigger('click');
        await panel.get('[data-testid="search-qianfan-api-key-input"]').setValue('q-key');
        await panel
            .get('[data-testid="search-provider-credential-tabs"]')
            .findAll('button')[1]!
            .trigger('click');
        await panel
            .get('[data-testid="search-qianfan-base-url-input"]')
            .setValue('https://gateway.test/v1');
        await panel.get('[data-testid="search-provider-editor-save"]').trigger('click');
        await settleSave();
        expect(saved().providers.qianfan).toMatchObject({
            apiKey: 'q-key',
            endpoint: 'https://gateway.test/v1',
        });
        expect(order()).toEqual(original);
    });

    it('user prioritizes an engine and fixed mode disables parallel fusion', async () => {
        const panel = await openPanel();
        await panel.get('[data-testid="search-strategy-priority"]').trigger('click');
        await panel.get('[data-testid="search-priority-top-tavily"]').trigger('click');
        await panel.get('[data-testid="search-parallel-toggle"]').trigger('click');
        await settleSave();
        expect(saved().providerPriority[0]).toBe('tavily');
        expect(saved().parallelProviders).toBe(true);
        await panel.get('[data-testid="search-strategy-manual"]').trigger('click');
        await settleSave();
        expect(saved()).toMatchObject({ routingStrategy: 'manual', parallelProviders: false });
        expect(panel.find('[data-testid="search-parallel-toggle"]').exists()).toBe(false);
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
