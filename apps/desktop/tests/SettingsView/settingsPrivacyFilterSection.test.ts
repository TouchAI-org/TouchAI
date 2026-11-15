import type { InvokeArgs } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { DOMWrapper, enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';
import type { DatabaseQueryRequest } from '@/services/NativeService/database';
import {
    PRIVACY_FILTER_DOWNLOAD_PROGRESS_EVENT,
    type PrivacyFilterModelInfo,
    type PrivacyFilterModelStatus,
} from '@/services/NativeService/privacyFilter';
import { PRIVACY_DATA_TYPES } from '@services/SettingsService/domain';
import { useSettingsStore } from '@/stores/settings';
import PrivacyFilterSection from '@/views/SettingsView/components/PrivacyFilter/index.vue';

import { mockTauriCommand } from '../utils/tauri';

enableAutoUnmount(afterEach);

const modelCatalog: PrivacyFilterModelInfo[] = [
    { id: 'astrlink-guard-int8', name: 'AstrLink Guard INT8', recommended: true },
    { id: 'openai-privacy-filter', name: 'OpenAI Privacy Filter Q8', recommended: false },
    { id: 'openmed-privacy-filter', name: 'OpenMed Privacy Filter Q8', recommended: false },
].map((model) => ({
    ...model,
    totalBytes: 1024,
    supported: true,
    dataTypes: [...PRIVACY_DATA_TYPES],
})) as PrivacyFilterModelInfo[];

function modelStatus(overrides: Partial<PrivacyFilterModelStatus> = {}): PrivacyFilterModelStatus {
    return {
        modelId: 'astrlink-guard-int8',
        installed: false,
        downloading: false,
        downloadedBytes: 0,
        totalBytes: 1024,
        currentFile: null,
        ...overrides,
    };
}

async function mountSection() {
    const wrapper = mount(PrivacyFilterSection, { attachTo: document.body });
    await flushPromises();
    return wrapper;
}

function pageControl(testId: string) {
    const element = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    if (!element) throw new Error(`Missing control: ${testId}`);
    return new DOMWrapper(element);
}

async function openModelOptions(wrapper: Awaited<ReturnType<typeof mountSection>>) {
    await wrapper.get('[data-testid="privacy-filter-model-select"]').trigger('keydown', {
        key: 'Enter',
    });
    await flushPromises();
}

async function ensureModelOptions(wrapper: Awaited<ReturnType<typeof mountSection>>) {
    if (!document.querySelector('[role="listbox"]')) await openModelOptions(wrapper);
}

async function selectMode(
    wrapper: Awaited<ReturnType<typeof mountSection>>,
    mode: 'rules' | 'model'
) {
    await wrapper.get('[data-testid="privacy-filter-mode-select"]').trigger('keydown', {
        key: 'Enter',
    });
    await flushPromises();
    pageControl(`privacy-filter-mode-${mode}`).element.dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true })
    );
    await flushPromises();
}

beforeEach(() => {
    setActivePinia(createPinia());
    setLocale('zh-CN');
    useSettingsStore().settings.privacyFilterSettings.enabled = true;
    mockTauriCommand('database_query', (payload?: InvokeArgs) => {
        const { request } = payload as { request: DatabaseQueryRequest };
        return {
            rows: [
                {
                    id: 1,
                    key: request.params?.[0],
                    value: request.params?.[1],
                    created_at: '2026-11-09 00:00:00',
                    updated_at: '2026-11-09 00:00:00',
                },
            ],
            rowsAffected: 1,
            lastInsertId: 1,
        };
    });
    mockTauriCommand('privacy_filter_model_status', modelStatus());
    mockTauriCommand('privacy_filter_models', modelCatalog);
    mockTauriCommand('privacy_filter_release_models', undefined);
    mockTauriCommand('privacy_filter_records', []);
});

describe('given the privacy settings page', () => {
    it('user opens the model list then sees AstrLink first with the only recommendation badge', async () => {
        const wrapper = await mountSection();
        await openModelOptions(wrapper);
        const options = document.querySelectorAll('[role="listbox"] [role="option"]');
        expect(options).toHaveLength(3);
        expect(options[0]?.textContent).toContain('AstrLink Guard INT8');
        expect(options[0]?.closest('[role="group"]')?.textContent).toContain('推荐');
        expect(
            document.querySelectorAll('[data-testid="privacy-filter-model-recommended"]')
        ).toHaveLength(1);
    });

    it('user downloads an OpenAI model then can select it and keeps that selection after reopening settings', async () => {
        let installed = false;
        let downloadedId: unknown;
        mockTauriCommand('privacy_filter_model_status', (payload?: InvokeArgs) => {
            const modelId = (payload as { modelId: PrivacyFilterModelStatus['modelId'] }).modelId;
            return modelStatus({
                modelId,
                installed: modelId === 'openai-privacy-filter' && installed,
            });
        });
        mockTauriCommand('privacy_filter_download_model', (payload?: InvokeArgs) => {
            downloadedId = (payload as { modelId: string }).modelId;
            installed = true;
        });
        const wrapper = await mountSection();
        await openModelOptions(wrapper);
        const option = pageControl('privacy-filter-model-openai-privacy-filter');
        const group = new DOMWrapper(option.element.closest<HTMLElement>('[role="group"]')!);
        await group.get('[data-testid="privacy-filter-download-model"]').trigger('click');
        await flushPromises();
        expect(downloadedId).toBe('openai-privacy-filter');
        expect(useSettingsStore().privacyFilterModelId).toBe('openai-privacy-filter');
    });

    it('user selects categories directly and keeps the selection after another category changes', async () => {
        const store = useSettingsStore();
        const wrapper = await mountSection();
        expect(wrapper.findAll('[data-testid^="privacy-filter-category-"]')).toHaveLength(10);
        const email = wrapper.get('[data-testid="privacy-filter-category-email"]');
        expect(email.element.tagName).toBe('BUTTON');
        expect(email.attributes('aria-pressed')).toBe('true');
        await email.trigger('click');
        await flushPromises();
        expect(email.attributes('aria-pressed')).toBe('false');
        expect(store.privacyFilterSettings.categories.email).toBe(false);

        const secrets = wrapper.get('[data-testid="privacy-filter-category-secrets"]');
        await secrets.trigger('click');
        await flushPromises();
        expect(secrets.attributes('aria-pressed')).toBe('false');
        expect(
            wrapper.get('[data-testid="privacy-filter-category-email"]').attributes('aria-pressed')
        ).toBe('false');
    });

    it('user adds a trimmed custom term once and can remove it from the saved list', async () => {
        const store = useSettingsStore();
        store.settings.privacyFilterSettings.useLocalModel = false;
        const wrapper = await mountSection();
        const input = wrapper.get<HTMLInputElement>(
            '[data-testid="privacy-filter-maskedWords-input"]'
        );
        const form = wrapper.get(
            '[data-settings-search-target="privacy-filter-masked-words"] form'
        );
        const add = wrapper.get('[data-testid="privacy-filter-maskedWords-add"]');

        expect(add.attributes('disabled')).toBeDefined();
        await input.setValue('  Project Nightfall  ');
        await form.trigger('submit');
        await flushPromises();

        expect(store.privacyFilterSettings.maskedWords).toEqual(['Project Nightfall']);
        expect(input.element.value).toBe('');
        expect(
            wrapper.get<HTMLInputElement>('[data-testid="privacy-filter-maskedWords-item"]').element
                .value
        ).toBe('Project Nightfall');

        await input.setValue('project nightfall');
        await form.trigger('submit');
        await flushPromises();
        expect(wrapper.findAll('[data-testid="privacy-filter-maskedWords-item"]')).toHaveLength(1);

        await wrapper.get('[data-testid="privacy-filter-maskedWords-remove"]').trigger('click');
        await flushPromises();
        expect(store.privacyFilterSettings.maskedWords).toEqual([]);
        expect(wrapper.find('[data-testid="privacy-filter-maskedWords-item"]').exists()).toBe(
            false
        );
    });

    it.each([
        { state: 'without a model', status: modelStatus() },
        { state: 'with an installed model', status: modelStatus({ installed: true }) },
        { state: 'during a download', status: modelStatus({ downloading: true }) },
    ])(
        'user opens disabled privacy filtering $state, then can only operate the header switch',
        async ({ status }) => {
            const store = useSettingsStore();
            mockTauriCommand('privacy_filter_model_status', status);
            store.settings.privacyFilterSettings.enabled = false;
            store.settings.privacyFilterSettings.categories.email = true;
            store.settings.privacyFilterSettings.maskedWords = ['Project Nightfall'];
            const wrapper = await mountSection();
            const enabled = wrapper.get<HTMLButtonElement>(
                'header [data-testid="privacy-filter-enabled-toggle"]'
            );
            expect(enabled.element.disabled).toBe(false);
            for (const control of wrapper.findAll('button, input')) {
                if (control.element !== enabled.element) {
                    expect(control.element.matches(':disabled'), control.html()).toBe(true);
                }
            }
            await openModelOptions(wrapper);
            expect(document.querySelector('[role="listbox"]')).toBeNull();

            await enabled.trigger('click');
            await flushPromises();
            expect(store.privacyFilterSettings.enabled).toBe(true);
            expect(
                wrapper.get('[data-testid="privacy-filter-mode-select"]').attributes('disabled')
            ).toBeUndefined();
            await selectMode(wrapper, 'rules');
            expect(
                wrapper
                    .get('[data-testid="privacy-filter-maskedWords-input"]')
                    .attributes('disabled')
            ).toBeUndefined();
        }
    );

    it('user switches modes, then sees only supported settings and retains saved choices', async () => {
        const store = useSettingsStore();
        store.settings.privacyFilterSettings.categories.email = true;
        store.settings.privacyFilterSettings.maskedWords = ['Project Nightfall'];
        mockTauriCommand('privacy_filter_model_status', modelStatus({ installed: true }));
        const wrapper = await mountSection();
        expect(wrapper.get('h1').text()).toBe('隐私保护');
        expect(wrapper.text()).toContain('基于本地模型和规则遮罩关键文本信息，保护您的隐私');
        expect(wrapper.find('[data-testid="privacy-filter-preview-input"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="privacy-filter-preview-run"]').exists()).toBe(false);
        expect(
            wrapper.find('[data-settings-search-target="privacy-filter-local-model"]').exists()
        ).toBe(false);
        expect(wrapper.get('[data-testid="privacy-filter-mode-select"]').text()).toContain(
            '本地模型'
        );
        expect(wrapper.find('[data-testid="privacy-filter-maskedWords-input"]').exists()).toBe(
            false
        );
        expect(wrapper.find('[data-testid="privacy-filter-secretPrefixes-input"]').exists()).toBe(
            false
        );
        expect(wrapper.text()).toContain('模型类别');
        expect(wrapper.text()).not.toContain('自定义规则');
        expect(wrapper.find('[data-testid="privacy-filter-download-source"]').exists()).toBe(false);
        await wrapper.get('[data-testid="privacy-filter-confidence-threshold"]').setValue('0.9');
        await wrapper.get('[data-testid="privacy-filter-category-privatePerson"]').trigger('click');
        await flushPromises();

        await selectMode(wrapper, 'rules');
        expect(wrapper.get('[data-testid="privacy-filter-mode-select"]').text()).toContain(
            '算法规则'
        );
        expect(wrapper.text()).toContain('规则类别');
        expect(wrapper.text()).not.toContain('模型类别');
        expect(wrapper.find('[data-testid="privacy-filter-maskedWords-input"]').exists()).toBe(
            true
        );
        expect(wrapper.find('[data-testid="privacy-filter-download-source"]').exists()).toBe(false);
        expect(store.privacyFilterSettings.useLocalModel).toBe(false);
        expect(wrapper.find('[data-testid="privacy-filter-model-select"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="privacy-filter-confidence-threshold"]').exists()).toBe(
            false
        );
        expect(wrapper.find('[data-testid="privacy-filter-category-privatePerson"]').exists()).toBe(
            false
        );
        expect(wrapper.findAll('[data-testid^="privacy-filter-category-"]')).toHaveLength(5);
        expect(wrapper.find('[data-testid="privacy-filter-category-email"]').exists()).toBe(true);

        await selectMode(wrapper, 'model');
        expect(store.privacyFilterSettings.useLocalModel).toBe(true);
        expect(
            wrapper.get<HTMLInputElement>('[data-testid="privacy-filter-confidence-threshold"]')
                .element.value
        ).toBe('0.9');
        expect(
            wrapper
                .get('[data-testid="privacy-filter-category-privatePerson"]')
                .attributes('aria-pressed')
        ).toBe('false');
        expect(store.privacyFilterSettings.maskedWords).toEqual(['Project Nightfall']);
    });

    it('user switches modes, then custom rules stay with algorithmic rules', async () => {
        const wrapper = await mountSection();

        expect(wrapper.find('[data-testid="privacy-filter-maskedWords-input"]').exists()).toBe(
            false
        );
        expect(wrapper.find('[data-testid="privacy-filter-secretPrefixes-input"]').exists()).toBe(
            false
        );

        await selectMode(wrapper, 'rules');
        expect(wrapper.find('[data-testid="privacy-filter-maskedWords-input"]').exists()).toBe(
            true
        );
        expect(wrapper.find('[data-testid="privacy-filter-secretPrefixes-input"]').exists()).toBe(
            true
        );

        await selectMode(wrapper, 'model');
        expect(wrapper.find('[data-testid="privacy-filter-maskedWords-input"]').exists()).toBe(
            false
        );
        expect(wrapper.find('[data-testid="privacy-filter-secretPrefixes-input"]').exists()).toBe(
            false
        );
    });

    it('user turns filtering off with model actions open, then the menu closes and all settings lock', async () => {
        const wrapper = await mountSection();
        await openModelOptions(wrapper);
        expect(pageControl('privacy-filter-download-model').attributes('disabled')).toBeUndefined();

        await wrapper.get('[data-testid="privacy-filter-enabled-toggle"]').trigger('click');
        await flushPromises();
        expect(document.querySelector('[data-testid="privacy-filter-download-model"]')).toBeNull();
        expect(
            wrapper.get('[data-testid="privacy-filter-model-select"]').attributes('disabled')
        ).toBeDefined();
        expect(
            wrapper.get('[data-testid="privacy-filter-mode-select"]').attributes('disabled')
        ).toBeDefined();
    });

    it('user retries an unavailable model status before being offered a download', async () => {
        mockTauriCommand('privacy_filter_model_status', () => {
            throw new Error('Model directory unavailable');
        });
        const wrapper = await mountSection();

        expect(wrapper.text()).toContain('无法读取模型状态');
        await openModelOptions(wrapper);
        await pageControl('privacy-filter-model-retry').trigger('click');
        await flushPromises();
        expect(wrapper.text()).toContain('无法读取模型状态');
        await openModelOptions(wrapper);
        expect(document.querySelector('[data-testid="privacy-filter-download-model"]')).toBeNull();

        mockTauriCommand('privacy_filter_model_status', modelStatus());
        await pageControl('privacy-filter-model-retry').trigger('click');
        await flushPromises();
        expect(wrapper.text()).not.toContain('无法读取模型状态');
        await openModelOptions(wrapper);
        expect(pageControl('privacy-filter-download-model').attributes('disabled')).toBeUndefined();
    });

    it('user sees a busy model action without a progress bar, cancels, and can download again', async () => {
        let status = modelStatus();
        let cancelDownload: (reason: Error) => void = () => {};
        mockTauriCommand('privacy_filter_model_status', () => status);
        mockTauriCommand('privacy_filter_download_model', () => {
            status = modelStatus({ downloading: true });
            return new Promise<void>((_resolve, reject) => {
                cancelDownload = reject;
            });
        });
        mockTauriCommand('privacy_filter_cancel_model_download', () => {
            status = modelStatus();
            cancelDownload(new Error('Download cancelled'));
        });
        const wrapper = await mountSection();

        await openModelOptions(wrapper);
        await pageControl('privacy-filter-download-model').trigger('click');
        await flushPromises();
        await emit(PRIVACY_FILTER_DOWNLOAD_PROGRESS_EVENT, {
            modelId: 'astrlink-guard-int8',
            downloadedBytes: 512,
            totalBytes: 1024,
            currentFile: 'model.onnx',
        });
        await flushPromises();
        expect(wrapper.find('[role="progressbar"]').exists()).toBe(false);
        expect(wrapper.get('[data-testid="privacy-filter-model-downloading"]').text()).toBe(
            '正在下载'
        );
        expect(
            pageControl('privacy-filter-cancel-download').attributes('disabled')
        ).toBeUndefined();
        expect(wrapper.find('[data-testid="privacy-filter-download-source"]').exists()).toBe(false);

        await selectMode(wrapper, 'rules');
        expect(wrapper.find('[role="progressbar"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="privacy-filter-cancel-download"]').exists()).toBe(false);
        await selectMode(wrapper, 'model');
        expect(wrapper.find('[role="progressbar"]').exists()).toBe(false);
        await openModelOptions(wrapper);
        expect(
            pageControl('privacy-filter-cancel-download').attributes('disabled')
        ).toBeUndefined();

        mockTauriCommand('privacy_filter_model_status', () => {
            throw new Error('Model status temporarily unavailable');
        });
        await emit(PRIVACY_FILTER_DOWNLOAD_PROGRESS_EVENT, {
            modelId: 'astrlink-guard-int8',
            downloadedBytes: 1024,
            totalBytes: 1024,
            currentFile: 'model.onnx',
        });
        await flushPromises();
        expect(wrapper.text()).toContain('无法读取模型状态');
        expect(
            pageControl('privacy-filter-cancel-download').attributes('disabled')
        ).toBeUndefined();

        mockTauriCommand('privacy_filter_model_status', () => status);
        await pageControl('privacy-filter-cancel-download').trigger('click');
        await emit(PRIVACY_FILTER_DOWNLOAD_PROGRESS_EVENT, {
            modelId: 'astrlink-guard-int8',
            downloadedBytes: 0,
            totalBytes: 0,
            currentFile: '',
        });
        await flushPromises();
        expect(wrapper.find('[role="progressbar"]').exists()).toBe(false);
        await ensureModelOptions(wrapper);
        expect(pageControl('privacy-filter-download-model').attributes('disabled')).toBeUndefined();

        mockTauriCommand('privacy_filter_download_model', () => {
            status = modelStatus({ installed: true, downloadedBytes: 1024 });
        });
        await pageControl('privacy-filter-download-model').trigger('click');
        await flushPromises();
        expect(wrapper.get('[data-testid="privacy-filter-model-select"]').text()).toContain(
            'AstrLink Guard INT8'
        );
        expect(document.querySelector('[data-testid="privacy-filter-download-model"]')).toBeNull();
        expect(pageControl('privacy-filter-delete-model').attributes('disabled')).toBeUndefined();
    });

    it('user downloads a model without a source setting so automatic fallback is used', async () => {
        let source: unknown;
        mockTauriCommand('privacy_filter_download_model', (payload?: InvokeArgs) => {
            source = (payload as { source: string }).source;
        });
        const wrapper = await mountSection();
        expect(wrapper.find('[data-testid="privacy-filter-download-source"]').exists()).toBe(false);
        await openModelOptions(wrapper);
        await pageControl('privacy-filter-download-model').trigger('click');
        await flushPromises();
        expect(source).toBe('auto');
    });

    it('user selects delete from an installed model, then the menu yields to confirmation before files are removed', async () => {
        let status = modelStatus({ installed: true, downloadedBytes: 1024 });
        mockTauriCommand('privacy_filter_model_status', () => status);
        mockTauriCommand('privacy_filter_delete_model', () => {
            status = modelStatus();
        });
        const wrapper = await mountSection();
        await openModelOptions(wrapper);
        await pageControl('privacy-filter-delete-model').trigger('click');
        await flushPromises();
        expect(document.querySelector('[role="listbox"]')).toBeNull();
        expect(status.installed).toBe(true);
        const dialog = new DOMWrapper(document.querySelector<HTMLElement>('[role="alertdialog"]')!);
        expect(dialog.text()).toContain('删除隐私识别模型');
        const confirm = dialog.findAll('button').find((button) => button.text() === '删除模型');
        expect(confirm).toBeDefined();
        await confirm!.trigger('click');
        await flushPromises();
        expect(status.installed).toBe(false);
        expect(wrapper.get('[data-testid="privacy-filter-model-select"]').text()).toContain(
            '选择模型'
        );
        expect(
            wrapper
                .get('[data-testid="privacy-filter-confidence-threshold"]')
                .attributes('disabled')
        ).toBeDefined();
    });
});
