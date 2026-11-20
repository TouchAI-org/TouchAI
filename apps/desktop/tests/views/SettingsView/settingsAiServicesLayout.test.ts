import { emit } from '@tauri-apps/api/event';
import { network } from '@tests/utils/agentWindow';
import { deferred, installProductAnalytics } from '@tests/utils/productAnalytics';
import { createSettingsPanelFixture } from '@tests/utils/settingsPanel';
import { createTestWindowPresentation } from '@tests/utils/windowPresentation';
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils';
import { beforeEach as beforePresentation } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'vue-sonner';

import { getProviderDriverDefinition } from '@/app/api/models/catalog';
import { AppEvent } from '@/app/api/settings/events';
import { setLocale, t } from '@/i18n';
import AiServicesSection from '@/views/SettingsView/components/AiServices/index.vue';

let fixture: Awaited<ReturnType<typeof createSettingsPanelFixture>>;
const wrappers: ReturnType<typeof mount>[] = [];
let discoveryModels: object[];
let metadataResponse: ReturnType<typeof deferred<Response>> | undefined;
let rejectActivation = false;
let rejectDefault = false;
const originalScroll = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');

beforeEach(async () => {
    vi.stubGlobal(
        'ResizeObserver',
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        }
    );
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
        configurable: true,
        value: vi.fn(),
    });
    toast.dismiss();
    rejectActivation = false;
    rejectDefault = false;
    metadataResponse = undefined;
    fixture = await createSettingsPanelFixture({
        query: {
            beforeQuery: ({ sql }) => {
                if (rejectActivation && sql.startsWith('update "providers"'))
                    throw new Error('private activation failure');
                if (
                    rejectDefault &&
                    sql.startsWith('update "models"') &&
                    sql.includes('"is_default"')
                )
                    throw new Error('private default failure');
            },
        },
    });
    fixture.database
        .prepare('INSERT INTO statistics (key, value) VALUES (?, ?)')
        .run('model_metadata_last_checked_at', new Date().toISOString());
    installProductAnalytics();
    discoveryModels = [{ id: 'gpt-5-mini' }];
    network.respondToDiscovery = async () =>
        network.discovery.at(-1)?.url.includes('models.dev')
            ? metadataResponse
                ? metadataResponse.promise
                : new Response(null, { status: 304 })
            : Response.json({ data: discoveryModels });
    setLocale('zh-CN');
});
afterEach(async () => {
    wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
    await fixture?.dispose();
    toast.dismiss();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (originalScroll) Object.defineProperty(Element.prototype, 'scrollIntoView', originalScroll);
    else Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
});

async function panel() {
    const wrapper = mount(AiServicesSection, fixture.viewOptions);
    wrappers.push(wrapper);
    await flushPromises();
    return wrapper;
}
async function selection(enabled = 1) {
    fixture.database.prepare('UPDATE providers SET enabled = ? WHERE id = 1').run(enabled);
    fixture.database.exec(
        `INSERT INTO models (id, provider_id, name, model_id) VALUES (2, 1, 'Other model', 'other-model');`
    );
    return panel();
}
function nextDefault(wrapper: ReturnType<typeof mount>) {
    return wrapper.get(`button[title="${t('settings.ai.setDefaultModel')}"]`);
}
function defaultId() {
    return fixture.database.prepare('SELECT id FROM models WHERE is_default = 1').get()?.id;
}
function providerEnabled() {
    return fixture.database.prepare('SELECT enabled FROM providers WHERE id = 1').get()?.enabled;
}
function defaultBadge(wrapper: ReturnType<typeof mount>) {
    return wrapper.get('[data-testid="default-model-badge"]').element.parentElement?.parentElement
        ?.textContent;
}
async function createProvider(wrapper: ReturnType<typeof mount>) {
    await wrapper.get('[data-testid="settings-add-custom-provider-button"]').trigger('click');
    await vi.dynamicImportSettled();
    await flushPromises();
    const dialog = new DOMWrapper(document.querySelector('[role="dialog"]')!);
    const fields = dialog.findAll('input[type="text"]');
    await fields[0]!.setValue('New Gateway');
    await fields[1]!.setValue('https://new.invalid/v1');
    await dialog
        .findAll('button')
        .find((button) => button.text() === t('common.create'))!
        .trigger('click');
    await flushPromises();
}

describe('given the real AI settings panel connected to production main', () => {
    it('user given a builtin provider when opening settings then sees its name without custom edit controls', async () => {
        fixture.database.exec(
            "UPDATE providers SET name = '火山引擎', is_builtin = 1 WHERE id = 1"
        );
        const wrapper = await panel();
        expect(wrapper.text()).toContain('火山引擎');
        expect(wrapper.find('[data-testid="settings-provider-driver-badge"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="settings-provider-edit-button"]').exists()).toBe(false);
    });

    it('user given a custom provider when opening settings then sees edit controls and actual driver metadata', async () => {
        const wrapper = await panel();
        expect(wrapper.find('[data-testid="settings-provider-edit-button"]').exists()).toBe(true);
        expect(wrapper.get('[data-testid="settings-provider-driver-badge"]').text()).toBe(
            getProviderDriverDefinition('openai-compatible').label
        );
        expect(wrapper.text()).toContain('Fixture');
    });

    it('user given a saved profile when editing its endpoint then saves through main and silently refreshes its models', async () => {
        const wrapper = await panel();
        vi.useFakeTimers();
        const endpoint = wrapper.get('[data-settings-search-target="provider-endpoint"] input');
        await endpoint.setValue('https://edited.invalid/v1');
        expect(
            fixture.database.prepare('SELECT api_endpoint FROM providers').get()?.api_endpoint
        ).toBe('https://fixture.invalid/v1');
        await vi.advanceTimersByTimeAsync(800);
        await flushPromises();
        expect(
            fixture.database.prepare('SELECT api_endpoint FROM providers').get()?.api_endpoint
        ).toBe('https://edited.invalid/v1');
        expect(network.discovery.at(-1)?.url).toBe('https://edited.invalid/v1/models');
        expect(endpoint.element).toHaveProperty('value', 'https://edited.invalid/v1');
        expect(document.body.textContent).not.toContain(
            t('settings.ai.refreshModelsSucceeded', { count: 1 })
        );
    });

    it('user given an empty provider list when creating a provider then sees its fetched models without a success toast', async () => {
        fixture.database.exec('DELETE FROM providers');
        const wrapper = await panel();
        await createProvider(wrapper);
        expect(fixture.database.prepare('SELECT name, api_endpoint FROM providers').get()).toEqual({
            name: 'New Gateway',
            api_endpoint: 'https://new.invalid/v1',
        });
        expect(wrapper.text()).toContain('gpt-5-mini');
        expect(document.body.textContent).not.toContain(
            t('settings.ai.refreshModelsSucceeded', { count: 1 })
        );
    });

    it('user given discovered model capabilities when refreshing then saves upstream metadata through its owner', async () => {
        const wrapper = await panel();
        discoveryModels = [
            {
                id: 'group/auto-gpt-5-6-sol',
                context_window: 400_000,
                max_output_tokens: 128_000,
                reasoning: true,
            },
            { id: 'qianai/plain-model' },
        ];
        await wrapper
            .get(`button[title="${t('settings.ai.refreshModelsTitle')}"]`)
            .trigger('click');
        await flushPromises();
        const saved = fixture.database
            .prepare(
                'SELECT context_limit, output_limit, reasoning, upstream_metadata FROM models WHERE model_id = ?'
            )
            .get('group/auto-gpt-5-6-sol');
        expect(saved).toMatchObject({
            context_limit: 400_000,
            output_limit: 128_000,
            reasoning: 1,
        });
        expect(JSON.parse(saved?.upstream_metadata as string)).toMatchObject({
            context_limit: 400_000,
            output_limit: 128_000,
            reasoning: 1,
        });
        expect(wrapper.text()).toContain('qianai/plain-model');
    });

    it('user given two enabled models when choosing a default then sees the committed default without replacing the list', async () => {
        const wrapper = await selection();
        const list = wrapper.get('.model-group').element.parentElement;
        await nextDefault(wrapper).trigger('click');
        await flushPromises();
        expect(defaultId()).toBe(2);
        expect(defaultBadge(wrapper)).toContain('Other model');
        expect(wrapper.get('.model-group').element.parentElement).toBe(list);
        expect(document.body.textContent).toContain(t('settings.ai.setSucceeded'));
    });

    it('user given a disabled provider when choosing its model then sees the provider enabled and its new default', async () => {
        const wrapper = await selection(0);
        await nextDefault(wrapper).trigger('click');
        await flushPromises();
        expect(providerEnabled()).toBe(1);
        expect(defaultId()).toBe(2);
        expect(wrapper.get('.provider-card [role="switch"]').attributes('aria-checked')).toBe(
            'true'
        );
        expect(defaultBadge(wrapper)).toContain('Other model');
    });

    it('user given a filtered model list when its own update notification returns then retains the input and scroll position', async () => {
        const wrapper = await selection();
        const filter = wrapper.get('[data-settings-search-target="models"] input[type="text"]');
        await filter.setValue('model');
        const scroll = wrapper.get<HTMLElement>('.settings-scrollbar');
        scroll.element.scrollTop = 320;
        await nextDefault(wrapper).trigger('click');
        await flushPromises();
        expect(filter.element).toHaveProperty('value', 'model');
        expect(scroll.element.scrollTop).toBe(320);
        expect(defaultId()).toBe(2);
    });

    it('user given a pending remote metadata request when opening settings then can already use saved local models', async () => {
        fixture.database.exec(
            "DELETE FROM statistics WHERE key = 'model_metadata_last_checked_at'"
        );
        metadataResponse = deferred<Response>();
        const wrapper = await selection();
        expect(nextDefault(wrapper).isVisible()).toBe(true);
        expect(defaultBadge(wrapper)).toContain('Fixture');
        metadataResponse.resolve(new Response(null, { status: 304 }));
        await flushPromises();
    });

    it('user given another settings instance when it announces a changed default then sees that committed model', async () => {
        const wrapper = await selection();
        await fixture.client.modelAdministration!.setDefaultModel({ modelId: 2 });
        await emit(AppEvent.AI_MODELS_UPDATED, {
            sourceId: 'another-settings-instance',
            updatedAt: Date.now(),
        });
        await flushPromises();
        expect(defaultBadge(wrapper)).toContain('Other model');
    });

    it('user given a failed provider activation when choosing a default then retains the old default and disabled state', async () => {
        const wrapper = await selection(0);
        rejectActivation = true;
        await nextDefault(wrapper).trigger('click');
        await flushPromises();
        expect(defaultId()).toBe(1);
        expect(providerEnabled()).toBe(0);
        expect(defaultBadge(wrapper)).toContain('Fixture');
        expect(document.body.textContent).toContain(t('settings.ai.setFailed'));
        expect(document.body.textContent).not.toContain('private activation failure');
    });

    it('user given a refused default transaction when choosing another enabled model then retains the saved default', async () => {
        const wrapper = await selection();
        rejectDefault = true;
        await nextDefault(wrapper).trigger('click');
        await flushPromises();
        expect(defaultId()).toBe(1);
        expect(defaultBadge(wrapper)).toContain('Fixture');
        expect(document.body.textContent).toContain(t('settings.ai.setFailed'));
        expect(document.body.textContent).not.toContain('private default failure');
    });

    it('user given activation succeeded but the default failed when choosing again then sees the persisted enabled provider and old default', async () => {
        const wrapper = await selection(0);
        rejectDefault = true;
        await nextDefault(wrapper).trigger('click');
        await flushPromises();
        expect(providerEnabled()).toBe(1);
        expect(defaultId()).toBe(1);
        expect(wrapper.get('.provider-card [role="switch"]').attributes('aria-checked')).toBe(
            'true'
        );
        expect(defaultBadge(wrapper)).toContain('Fixture');
        expect(document.body.textContent).toContain(t('settings.ai.setFailed'));
    });
});

beforePresentation(async () => {
    (await createTestWindowPresentation('settings')).install();
});
