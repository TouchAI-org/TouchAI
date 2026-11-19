import { emit } from '@tauri-apps/api/event';
import { createSettingsPanelFixture } from '@tests/utils/settingsPanel';
import { getTauriInvokeCalls } from '@tests/utils/tauri';
import { createTestWindowPresentation } from '@tests/utils/windowPresentation';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { beforeEach as beforePresentation } from 'vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listModelOptions } from '@/app/api/models/selection';
import { setLocale, t } from '@/i18n';
import type { DatabaseQueryRequest } from '@/platform/native/database';
import UpgradeModelToolConfig from '@/views/SettingsView/components/BuiltInTools/components/UpgradeModelToolConfig.vue';

let fixture: Awaited<ReturnType<typeof createSettingsPanelFixture>>;
let wrapper: VueWrapper | undefined;
let delayReads = false;
let failReads = false;
let delayListener = false;
let pendingReads: Array<() => void>;
let releaseListener: (() => void) | undefined;

function isModelList(payload: unknown) {
    const request = (payload as { request?: DatabaseQueryRequest } | undefined)?.request;
    return request?.method === 'all' && request.sql.includes('from "models" inner join');
}

beforeEach(async () => {
    delayReads = false;
    failReads = false;
    delayListener = false;
    pendingReads = [];
    releaseListener = undefined;
    fixture = await createSettingsPanelFixture({
        query: {
            async aroundInvoke(call, next) {
                if (call.cmd === 'database_query' && isModelList(call.payload)) {
                    if (failReads) throw new Error('fixture model query unavailable');
                    const rows = await next();
                    if (delayReads)
                        await new Promise<void>((resolve) => {
                            pendingReads.push(resolve);
                        });
                    return rows;
                }
                if (
                    delayListener &&
                    call.cmd === 'plugin:event|listen' &&
                    (call.payload as { event?: string })?.event === 'ai-models:updated'
                ) {
                    await new Promise<void>((resolve) => {
                        releaseListener = resolve;
                    });
                }
                return next();
            },
        },
    });
    setLocale('en-US');
});
afterEach(async () => {
    wrapper?.unmount();
    wrapper = undefined;
    delayReads = false;
    delayListener = false;
    pendingReads.forEach((release) => release());
    releaseListener?.();
    await flushPromises();
    await fixture.dispose();
    document.body.innerHTML = '';
});

function mountPanel(chain = [{ providerId: 1, modelId: 'fixture-model' }]) {
    wrapper = mount(UpgradeModelToolConfig, {
        ...fixture.viewOptions,
        props: { modelValue: { chain } },
    });
    return wrapper;
}
async function updated() {
    await emit('ai-models:updated', { updatedAt: 0 });
    await flushPromises();
}
function addButton() {
    return wrapper!.get<HTMLButtonElement>(
        `button[aria-label="${t('settings.builtInTools.upgradeModel.addModel')}"]`
    );
}

describe('given the real upgrade configuration panel reads safe application model options', () => {
    it('user reads available models without receiving any saved connection credentials', async () => {
        const models = await listModelOptions();
        expect(models).toContainEqual(
            expect.objectContaining({ model_id: 'fixture-model', provider_name: 'Fixture' })
        );
        expect(JSON.stringify(models)).not.toMatch(
            /fixture-secret|api_key|api_endpoint|provider_config_json/
        );
    });

    it('user adds an unused enabled model while a disabled provider and existing selection stay out of the new choice', async () => {
        fixture.database
            .exec(`INSERT INTO models (id, provider_id, name, model_id) VALUES (2, 1, 'Next model', 'next-model');
            INSERT INTO providers (id, name, driver, api_endpoint, enabled, logo) VALUES (2, 'Disabled', 'openai-compatible', 'https://disabled.invalid', 0, 'openai.png');
            INSERT INTO models (id, provider_id, name, model_id) VALUES (3, 2, 'Disabled model', 'disabled-model');`);
        mountPanel();
        await flushPromises();
        expect(wrapper!.text()).toContain('Fixture');
        await addButton().trigger('click');
        expect(wrapper!.emitted('update:modelValue')?.at(-1)?.[0]).toEqual({
            chain: [
                { providerId: 1, modelId: 'fixture-model' },
                { providerId: 1, modelId: 'next-model' },
            ],
        });
        expect(addButton().element.disabled).toBe(true);
        expect(wrapper!.text()).not.toContain('Disabled model');
    });

    it('user keeps a saved unavailable model visible when the model list is empty', async () => {
        fixture.database.exec('DELETE FROM models');
        mountPanel();
        await flushPromises();
        expect(wrapper!.text()).toContain('fixture-model');
        expect(addButton().element.disabled).toBe(true);
        expect(wrapper!.emitted('update:modelValue')).toBeUndefined();
    });

    it('user sees the latest model names when an older query returns after a newer update', async () => {
        delayReads = true;
        mountPanel();
        await expect.poll(() => pendingReads.length).toBe(1);
        fixture.database.exec("UPDATE models SET name = 'Latest model' WHERE id = 1");
        await updated();
        await expect.poll(() => pendingReads.length).toBe(2);
        pendingReads[1]!();
        await flushPromises();
        expect(wrapper!.text()).toContain('Latest model');
        pendingReads[0]!();
        await flushPromises();
        expect(wrapper!.text()).toContain('Latest model');
    });

    it('user retains the saved selection on a query failure and a following update recovers its label', async () => {
        failReads = true;
        mountPanel();
        await flushPromises();
        expect(wrapper!.text()).toContain('fixture-model');
        failReads = false;
        fixture.database.exec("UPDATE models SET name = 'Recovered model' WHERE id = 1");
        await updated();
        expect(wrapper!.text()).toContain('Recovered model');
        expect(wrapper!.emitted('update:modelValue')).toBeUndefined();
    });

    it('user closes before a listener registers and later model changes cannot launch detached queries', async () => {
        delayListener = true;
        mountPanel();
        await expect.poll(() => releaseListener).toBeTruthy();
        await flushPromises();
        wrapper!.unmount();
        releaseListener!();
        await flushPromises();
        const readsAfterClose = getTauriInvokeCalls('database_query').filter((call) =>
            isModelList(call.payload)
        ).length;
        await updated();
        expect(
            getTauriInvokeCalls('database_query').filter((call) => isModelList(call.payload))
        ).toHaveLength(readsAfterClose);
    });
});

function seedCatalog() {
    fixture.database.exec(`UPDATE providers SET name = 'Acme', logo = 'openai.png' WHERE id = 1;
        UPDATE models SET name = 'GPT 5', model_id = 'gpt-5' WHERE id = 1;
        INSERT INTO models (id, provider_id, name, model_id) VALUES (2, 1, 'GPT 5 Mini', 'gpt-5-mini');
        INSERT INTO providers (id, name, driver, api_endpoint, logo) VALUES (2, 'Beta', 'anthropic', 'https://beta.invalid', 'anthropic.png');
        INSERT INTO models (id, provider_id, name, model_id) VALUES (3, 2, 'Claude', 'claude');`);
}
function chainRows() {
    return wrapper!.findAll('[data-row-uid]');
}
function lastChain() {
    return wrapper!.emitted('update:modelValue')?.at(-1)?.[0];
}
async function chooseRow(row: number, field: 'provider' | 'model', label: string) {
    await chainRows()
        [row]!.findAll('button[aria-expanded]')
        [field === 'provider' ? 0 : 1]!.trigger('click');
    const option = chainRows()
        [row]!.findAll('button[aria-selected]')
        .find((button) => button.text().includes(label));
    expect(option).toBeDefined();
    await option!.trigger('mousedown');
    await flushPromises();
}

describe('given saved upgrade chains and actual row controls', () => {
    it.each(['zh-CN', 'en-US'] as const)(
        'user is invited to add the first model in %s when the chain is empty',
        async (locale) => {
            seedCatalog();
            setLocale(locale);
            mountPanel([]);
            await flushPromises();
            expect(wrapper!.text()).toContain(t('settings.builtInTools.upgradeModel.emptyChain'));
            expect(wrapper!.text()).toContain(t('settings.builtInTools.upgradeModel.addModel'));
            expect(chainRows()).toHaveLength(0);
        }
    );

    it('user sees a card for every saved provider and model in the chain', async () => {
        seedCatalog();
        mountPanel([
            { providerId: 1, modelId: 'gpt-5' },
            { providerId: 2, modelId: 'claude' },
        ]);
        await flushPromises();
        expect(chainRows()).toHaveLength(2);
        expect(chainRows()[0]!.text()).toContain('GPT 5');
        expect(chainRows()[1]!.text()).toContain('Claude');
    });

    it('user adds the first available model to an empty chain', async () => {
        seedCatalog();
        mountPanel([]);
        await flushPromises();
        await addButton().trigger('click');
        expect(lastChain()).toEqual({ chain: [{ providerId: 1, modelId: 'gpt-5' }] });
        expect(chainRows()).toHaveLength(1);
    });

    it('user cannot add an already selected model a second time', async () => {
        seedCatalog();
        mountPanel([
            { providerId: 1, modelId: 'gpt-5' },
            { providerId: 1, modelId: 'gpt-5-mini' },
            { providerId: 2, modelId: 'claude' },
        ]);
        await flushPromises();
        expect(addButton().element.disabled).toBe(true);
    });

    it('user sees a committed configuration change reflected in its saved row', async () => {
        seedCatalog();
        mountPanel([]);
        await flushPromises();
        await wrapper!.setProps({ modelValue: { chain: [{ providerId: 2, modelId: 'claude' }] } });
        expect(chainRows()).toHaveLength(1);
        expect(wrapper!.text()).toContain('Beta');
        expect(wrapper!.emitted('update:modelValue')).toBeUndefined();
    });

    it('user removes one model and retains the other saved chain entry', async () => {
        seedCatalog();
        mountPanel([
            { providerId: 1, modelId: 'gpt-5' },
            { providerId: 2, modelId: 'claude' },
        ]);
        await flushPromises();
        await chainRows()[0]!
            .get(`button[aria-label="${t('settings.builtInTools.upgradeModel.removeModel')}"]`)
            .trigger('click');
        expect(lastChain()).toEqual({ chain: [{ providerId: 2, modelId: 'claude' }] });
    });

    it('user picks another model belonging to the same provider', async () => {
        seedCatalog();
        mountPanel([{ providerId: 1, modelId: 'gpt-5' }]);
        await flushPromises();
        await chooseRow(0, 'model', 'GPT 5 Mini');
        expect(lastChain()).toEqual({ chain: [{ providerId: 1, modelId: 'gpt-5-mini' }] });
    });

    it('user switches provider and the row moves to its first available model', async () => {
        seedCatalog();
        mountPanel([{ providerId: 1, modelId: 'gpt-5' }]);
        await flushPromises();
        await chooseRow(0, 'provider', 'Beta');
        expect(lastChain()).toEqual({ chain: [{ providerId: 2, modelId: 'claude' }] });
    });

    it('user can add a model saved elsewhere after the existing choices have all been used', async () => {
        seedCatalog();
        mountPanel([
            { providerId: 1, modelId: 'gpt-5' },
            { providerId: 1, modelId: 'gpt-5-mini' },
            { providerId: 2, modelId: 'claude' },
        ]);
        await flushPromises();
        expect(addButton().element.disabled).toBe(true);
        fixture.database
            .exec(`INSERT INTO providers (id, name, driver, api_endpoint, logo) VALUES (3, 'Gamma', 'google', 'https://gamma.invalid', 'google.png');
            INSERT INTO models (id, provider_id, name, model_id) VALUES (4, 3, 'Gemini', 'gemini');`);
        await updated();
        await addButton().trigger('click');
        expect(lastChain()).toEqual({
            chain: [
                { providerId: 1, modelId: 'gpt-5' },
                { providerId: 1, modelId: 'gpt-5-mini' },
                { providerId: 2, modelId: 'claude' },
                { providerId: 3, modelId: 'gemini' },
            ],
        });
    });

    it('user is told to configure models when no provider is enabled', async () => {
        fixture.database.exec('UPDATE providers SET enabled = 0');
        mountPanel([]);
        await flushPromises();
        expect(wrapper!.text()).toContain(
            t('settings.builtInTools.upgradeModel.configureModelsFirst')
        );
        expect(addButton().element.disabled).toBe(true);
    });

    it('user keeps an empty chain when its model query fails without an invented default', async () => {
        failReads = true;
        mountPanel([]);
        await flushPromises();
        expect(chainRows()).toHaveLength(0);
        expect(addButton().element.disabled).toBe(true);
        expect(wrapper!.emitted('update:modelValue')).toBeUndefined();
    });
});

beforePresentation(async () => {
    (await createTestWindowPresentation('settings')).install();
});
