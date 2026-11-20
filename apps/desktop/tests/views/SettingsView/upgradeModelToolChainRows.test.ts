import { createSettingsPanelFixture } from '@tests/utils/settingsPanel';
import { createTestWindowPresentation } from '@tests/utils/windowPresentation';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { beforeEach as beforePresentation } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    parseUpgradeModelToolConfig,
    serializeUpgradeModelToolConfig,
} from '@/app/api/tools/configuration';
import { setLocale, t } from '@/i18n';
import UpgradeModelToolConfig from '@/views/SettingsView/components/BuiltInTools/components/UpgradeModelToolConfig.vue';

let fixture: Awaited<ReturnType<typeof createSettingsPanelFixture>>;
let wrapper: VueWrapper | undefined;
const hitTest = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');
beforeEach(async () => {
    fixture = await createSettingsPanelFixture();
    setLocale('en-US');
    fixture.database.exec(`UPDATE providers SET name = 'Acme', logo = 'openai.png' WHERE id = 1;
        UPDATE models SET name = 'GPT 5', model_id = 'gpt-5', reasoning = 1 WHERE id = 1;
        INSERT INTO models (id, provider_id, name, model_id) VALUES (2, 1, 'GPT 5 Mini', 'gpt-5-mini');
        INSERT INTO providers (id, name, driver, api_endpoint, logo) VALUES (2, 'Beta', 'anthropic', 'https://beta.invalid', 'anthropic.png');
        INSERT INTO models (id, provider_id, name, model_id) VALUES (3, 2, 'Claude', 'claude');`);
});
afterEach(async () => {
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    wrapper?.unmount();
    wrapper = undefined;
    vi.restoreAllMocks();
    if (hitTest) Object.defineProperty(document, 'elementFromPoint', hitTest);
    else Reflect.deleteProperty(document, 'elementFromPoint');
    await fixture.dispose();
    document.body.innerHTML = '';
});
async function mountConfig(chain = [{ providerId: 1, modelId: 'gpt-5' }]) {
    wrapper = mount(UpgradeModelToolConfig, {
        ...fixture.viewOptions,
        props: { modelValue: { chain } },
    });
    await flushPromises();
    return wrapper;
}
function rows() {
    return wrapper!.findAll('[data-row-uid]');
}
async function open(field: 'provider' | 'model', row = 0) {
    await rows()
        [row]!.findAll('button[aria-expanded]')
        [field === 'provider' ? 0 : 1]!.trigger('click');
}
async function choose(field: 'provider' | 'model', label: string) {
    await open(field);
    const choice = rows()[0]!
        .findAll('button[aria-selected]')
        .find((button) => button.text().includes(label));
    expect(choice).toBeDefined();
    await choice!.trigger('mousedown');
    await flushPromises();
}
function latestChain() {
    return wrapper!.emitted('update:modelValue')?.at(-1)?.[0];
}

async function startDrag() {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: HTMLElement
    ) {
        const row = this.closest<HTMLElement>('[data-row-uid]');
        if (row)
            return new DOMRect(0, [...row.parentElement!.children].indexOf(row) * 100, 300, 80);
        return new DOMRect(0, 0, 300, 200);
    });
    Object.defineProperty(document, 'elementFromPoint', {
        configurable: true,
        value: (_x: number, y: number) => rows()[y >= 100 ? 1 : 0]!.element,
    });
    const first = rows()[0]!;
    first.get('.upgrade-model-drag-handle').element.dispatchEvent(
        new PointerEvent('pointerdown', {
            button: 0,
            pointerType: 'mouse',
            clientX: 10,
            clientY: 10,
            bubbles: true,
            cancelable: true,
        })
    );
    document.dispatchEvent(
        new PointerEvent('pointermove', {
            pointerType: 'mouse',
            clientX: 20,
            clientY: 30,
            bubbles: true,
            cancelable: true,
        })
    );
    await expect.poll(() => first.classes()).toContain('upgrade-model-chain-card--source-dragging');
    return first;
}
async function endDrag() {
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    await flushPromises();
}

describe('given actual upgrade rows retain missing or disabled saved choices', () => {
    it('user keeps a row whose provider no longer exists instead of silently losing it', async () => {
        await mountConfig([{ providerId: 99, modelId: 'ghost-model' }]);
        expect(rows()).toHaveLength(1);
        expect(wrapper!.text()).toContain('Provider #99');
    });
    it('user keeps the missing model identifier visible in its saved row', async () => {
        await mountConfig([{ providerId: 99, modelId: 'ghost-model' }]);
        expect(wrapper!.text()).toContain('ghost-model');
    });
    it('user sees why a missing provider is unavailable when opening its choices', async () => {
        await mountConfig([{ providerId: 99, modelId: 'ghost-model' }]);
        await open('provider');
        expect(wrapper!.text()).toContain(
            t('settings.builtInTools.upgradeModel.selectedProviderUnavailable')
        );
    });
    it('user sees why a disabled provider remains in its saved row', async () => {
        fixture.database.exec('UPDATE providers SET enabled = 0 WHERE id = 1');
        await mountConfig();
        await open('provider');
        expect(wrapper!.text()).toContain(
            t('settings.builtInTools.upgradeModel.selectedProviderDisabled')
        );
    });
    it('user sees a provider initial when the saved provider has no available logo', async () => {
        await mountConfig([{ providerId: 99, modelId: 'ghost-model' }]);
        expect(rows()[0]!.find('img[alt="Provider #99"]').exists()).toBe(false);
        expect(
            rows()[0]!
                .findAll('[translate="no"]')
                .some((node) => node.text() === 'P')
        ).toBe(true);
    });
    it('user sees the actual provider logo for a configured provider', async () => {
        await mountConfig();
        expect(rows()[0]!.get('img[alt="Acme"]').attributes('src')).toContain('openai');
    });
    it('user sees disabled-model wording rather than a blank model choice', async () => {
        fixture.database.exec('UPDATE providers SET enabled = 0 WHERE id = 1');
        await mountConfig();
        await open('model');
        expect(wrapper!.text()).toContain(
            t('settings.builtInTools.upgradeModel.selectedModelProviderDisabled')
        );
    });
    it('user sees the real model logo for a known model identifier', async () => {
        await mountConfig();
        expect(rows()[0]!.get('img[alt="GPT 5"]').attributes('src')).toContain('openai');
    });
    it('user reads the actual reported model capabilities in its choice list', async () => {
        await mountConfig();
        await open('model');
        expect(wrapper!.text()).toContain(t('model.capability.reasoning'));
        expect(wrapper!.text()).toContain(t('model.capability.tools'));
    });
});

describe('given the installed drag library and controlled browser geometry', () => {
    const chain = [
        { providerId: 1, modelId: 'gpt-5' },
        { providerId: 2, modelId: 'claude' },
    ];
    it('user sees a dragging row marked until the pointer is released', async () => {
        await mountConfig(chain);
        const first = await startDrag();
        await endDrag();
        expect(first.classes()).not.toContain('upgrade-model-chain-card--source-dragging');
    });
    it('user drops without changing order and no redundant chain save is emitted', async () => {
        await mountConfig(chain);
        await startDrag();
        await endDrag();
        expect(wrapper!.emitted('update:modelValue')).toBeUndefined();
    });
    it('user moves a row below the next row and saves the new order after dropping', async () => {
        await mountConfig(chain);
        const first = await startDrag();
        document.dispatchEvent(
            new PointerEvent('pointermove', {
                pointerType: 'mouse',
                clientX: 20,
                clientY: 179,
                bubbles: true,
                cancelable: true,
            })
        );
        await expect.poll(() => rows()[1]!.element === first.element).toBe(true);
        await endDrag();
        expect(latestChain()).toEqual({
            chain: [
                { providerId: 2, modelId: 'claude' },
                { providerId: 1, modelId: 'gpt-5' },
            ],
        });
    });
});

describe('given actual choices and the public configuration validator', () => {
    it('user cannot serialize a nonnumeric provider identity into a saved upgrade chain', () => {
        expect(() =>
            serializeUpgradeModelToolConfig({
                chain: [{ providerId: Number.NaN, modelId: 'gpt-5' }],
            })
        ).toThrow();
        expect(
            parseUpgradeModelToolConfig(
                '{"chain":[{"providerId":"not-a-number","modelId":"gpt-5"}]}'
            )
        ).toEqual({ chain: [] });
    });
    it('user reselects the current provider without a redundant update', async () => {
        await mountConfig();
        await choose('provider', 'Acme');
        expect(wrapper!.emitted('update:modelValue')).toBeUndefined();
    });
    it('user cannot choose a provider that has no enabled models', async () => {
        fixture.database.exec('UPDATE providers SET enabled = 0 WHERE id = 2');
        await mountConfig();
        await open('provider');
        expect(
            rows()[0]!
                .findAll('button[aria-selected]')
                .map((button) => button.text())
        ).not.toEqual(expect.arrayContaining([expect.stringContaining('Beta')]));
        expect(wrapper!.emitted('update:modelValue')).toBeUndefined();
    });
    it('user cannot serialize an empty model identity into a saved upgrade chain', () => {
        expect(() =>
            serializeUpgradeModelToolConfig({ chain: [{ providerId: 1, modelId: '   ' }] })
        ).toThrow();
        expect(parseUpgradeModelToolConfig('{"chain":[{"providerId":1,"modelId":"   "}]}')).toEqual(
            { chain: [] }
        );
    });
    it('user reselects the current model without a redundant update', async () => {
        await mountConfig();
        await choose('model', 'GPT 5');
        expect(wrapper!.emitted('update:modelValue')).toBeUndefined();
    });
    it('user picks another valid model and receives its unchanged provider identity', async () => {
        await mountConfig();
        await choose('model', 'GPT 5 Mini');
        expect(latestChain()).toEqual({ chain: [{ providerId: 1, modelId: 'gpt-5-mini' }] });
    });
});

beforePresentation(async () => {
    (await createTestWindowPresentation('settings')).install();
});
