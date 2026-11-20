import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ProviderSettingsImportScan } from '@/app/api/models/providerSettingsImport';
import { setLocale } from '@/i18n';
import ProviderSettingsImportDialog from '@/views/SettingsView/components/AiServices/components/ProviderSettingsImportDialog.vue';

const fixtureKey = Array.from({ length: 12 }, () => 'x').join('');

function sources(): ProviderSettingsImportScan {
    return {
        claudeCode: {
            status: 'available',
            candidate: {
                providerName: 'Claude Code',
                driver: 'anthropic-compatible',
                apiEndpoint: 'https://gateway.example.test',
                modelId: 'claude-sonnet',
                apiKey: fixtureKey,
            },
        },
        codex: { status: 'missing', candidate: null },
    };
}

const previews: ReturnType<typeof mount>[] = [];

async function preview(overrides: Record<string, unknown> = {}) {
    const wrapper = mount(ProviderSettingsImportDialog, {
        attachTo: document.body,
        props: {
            open: true,
            sources: sources(),
            scanning: false,
            saving: false,
            error: null,
            ...overrides,
        },
        global: {
            stubs: { Teleport: { template: '<div><slot /></div>' } },
        },
    });
    await flushPromises();
    previews.push(wrapper);
    return wrapper;
}

describe('user previews local API settings', () => {
    beforeEach(() => setLocale('en-US'));
    afterEach(() => previews.splice(0).forEach((wrapper) => wrapper.unmount()));

    it('user sees compatible fields and a fixed mask when an API key is available', async () => {
        const wrapper = await preview();
        expect(wrapper.text()).toContain('https://gateway.example.test');
        expect(wrapper.text()).toContain('claude-sonnet');
        expect(wrapper.text()).toContain('Anthropic');
        expect(wrapper.get('[data-testid="provider-import-api-key"]').text()).toBe('••••••••');
        expect(wrapper.html().includes(fixtureKey)).toBe(false);
        expect(wrapper.emitted('import')).toBeUndefined();
    });

    it('user imports only selected sources when confirming the preview', async () => {
        const scan = sources();
        scan.codex = {
            status: 'partial',
            candidate: { ...scan.claudeCode.candidate!, providerName: 'Codex', apiKey: null },
        };
        const wrapper = await preview({ sources: scan });
        await wrapper.get('[data-testid="provider-import-select-codex"]').trigger('click');
        await wrapper.get('[data-testid="provider-import-confirm"]').trigger('click');
        expect(wrapper.emitted('import')).toEqual([[['claudeCode']]]);
    });

    it('user can skip the preview without importing anything', async () => {
        const wrapper = await preview();
        await wrapper.get('[data-testid="provider-import-cancel"]').trigger('click');
        expect(wrapper.emitted('update:open')).toEqual([[false]]);
        expect(wrapper.emitted('import')).toBeUndefined();
    });

    it('user cannot confirm when no compatible source is selected', async () => {
        const wrapper = await preview();
        await wrapper.get('[data-testid="provider-import-select-claudeCode"]').trigger('click');
        expect(
            wrapper.get('[data-testid="provider-import-confirm"]').attributes('disabled')
        ).toBeDefined();
    });

    it('user sees unavailable source statuses when neither config can be imported', async () => {
        const wrapper = await preview({
            sources: {
                claudeCode: { status: 'malformed', candidate: null },
                codex: { status: 'unsupported', candidate: null },
            },
        });
        expect(wrapper.text()).toContain('Invalid configuration');
        expect(wrapper.text()).toContain('Unsupported configuration');
        expect(wrapper.find('[data-testid="provider-import-select-claudeCode"]').exists()).toBe(
            false
        );
        expect(
            wrapper.get('[data-testid="provider-import-confirm"]').attributes('disabled')
        ).toBeDefined();
    });

    it('user can rescan after source errors and cannot rescan while saving', async () => {
        const wrapper = await preview();
        await wrapper.get('[data-testid="provider-import-retry"]').trigger('click');
        expect(wrapper.emitted('retry')).toHaveLength(1);

        await wrapper.setProps({ saving: true });
        expect(wrapper.find('[data-testid="provider-import-retry"]').exists()).toBe(false);

        await wrapper.setProps({ saving: false, scanning: true });
        expect(wrapper.find('[data-testid="provider-import-retry"]').exists()).toBe(false);
    });

    it('user can cancel a pending scan and cannot confirm until it completes', async () => {
        const wrapper = await preview({ sources: null, scanning: true });
        expect(wrapper.get('[role="status"]').text()).toContain('Scanning');
        expect(
            wrapper.get('[data-testid="provider-import-confirm"]').attributes('disabled')
        ).toBeDefined();
        expect(
            wrapper.get('[data-testid="provider-import-cancel"]').attributes('disabled')
        ).toBeUndefined();
    });

    it('user sees the save error and cannot submit twice while saving', async () => {
        const wrapper = await preview({ saving: true });
        expect(
            wrapper.get('[data-testid="provider-import-confirm"]').attributes('disabled')
        ).toBeDefined();
        expect(
            wrapper.get('[data-testid="provider-import-cancel"]').attributes('disabled')
        ).toBeDefined();
        await wrapper.setProps({ saving: false, error: 'Import failed. Nothing was saved.' });
        await flushPromises();
        expect(wrapper.get('[role="alert"]').text()).toBe('Import failed. Nothing was saved.');
    });
});
