import type { InvokeArgs } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { DOMWrapper, enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { privacyApiKey } from '@/app/api/privacy';
import { assemblePrivacyWindow } from '@/app/composition/privacy';
import { setLocale } from '@/i18n';
import { PRIVACY_DATA_TYPES } from '@/modules/privacy/public';
import type { DatabaseQueryRequest } from '@/platform/native/database';
import {
    PRIVACY_FILTER_DOWNLOAD_PROGRESS_EVENT,
    type PrivacyFilterModelInfo,
    type PrivacyFilterModelStatus,
} from '@/platform/native/privacyFilter';
import { usePrivacyStore } from '@/stores/privacy';
import PrivacyFilterSection from '@/views/SettingsView/components/PrivacyFilter/index.vue';

import { createSettingsWindowFixture } from '../utils/settingsWindow';
import { getTauriInvokeCalls, interceptTauriInvoke, mockTauriCommand } from '../utils/tauri';

enableAutoUnmount(afterEach);

const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');

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

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((accept, fail) => {
        resolve = accept;
        reject = fail;
    });
    return { promise, resolve, reject };
}

async function mountSection() {
    const wrapper = mount(PrivacyFilterSection, {
        ...fixture.viewOptions,
        global: {
            ...fixture.viewOptions.global,
            provide: {
                ...fixture.viewOptions.global.provide,
                [privacyApiKey as symbol]: privacyWindow.api,
            },
        },
        attachTo: document.body,
    });
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
    await wrapper.get(`[role="radio"][data-testid="privacy-filter-mode-${mode}"]`).trigger('click');
    await flushPromises();
}

let fixture: ReturnType<typeof createSettingsWindowFixture>;
let privacyWindow: ReturnType<typeof assemblePrivacyWindow>;
const useSettingsStore = () => fixture.app.runWithContext(() => usePrivacyStore(fixture.pinia));

beforeEach(async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
        configurable: true,
        value: vi.fn(),
    });
    setActivePinia(createPinia());
    setLocale('zh-CN');
    fixture = createSettingsWindowFixture({ values: { language: 'zh-CN' } });
    privacyWindow = assemblePrivacyWindow(fixture.window.privacySettings);
    fixture.app.provide(privacyApiKey, privacyWindow.api);
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
    mockTauriCommand('privacy_filter_detect', [[]]);
    mockTauriCommand('privacy_filter_records', []);
    await fixture.initialize();
    const store = useSettingsStore();
    await store.initialize();
    await store.updatePrivacyFilterSettings({ ...store.privacyFilterSettings, enabled: true });
});

afterEach(() => {
    vi.useRealTimers();
    if (originalScrollIntoView)
        Object.defineProperty(Element.prototype, 'scrollIntoView', originalScrollIntoView);
    else Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
    privacyWindow.dispose();
    fixture.dispose();
});

describe('given the privacy settings page', () => {
    describe('given the model failure control is ready', () => {
        let wrapper: Awaited<ReturnType<typeof mountSection>>;
        beforeEach(async () => {
            wrapper = await mountSection();
        });

        it('user chooses how to handle a masking failure then the saved choice and its effect are visible when settings reopen', async () => {
            const select = '[data-testid="privacy-filter-failure-action"]';
            const trigger = wrapper.get(select);
            expect(trigger.text()).toBe('降级为算法');

            await trigger.trigger('keydown', { key: 'Enter' });
            await flushPromises();
            expect(
                [...document.querySelectorAll('[role="listbox"] [role="option"]')].map((option) =>
                    option.textContent?.trim()
                )
            ).toEqual(['阻止发送', '降级为算法', '原文发送']);
            await pageControl('privacy-filter-failure-send-original').trigger('keydown', {
                key: 'Enter',
            });
            await flushPromises();
            wrapper.unmount();

            const reopened = await mountSection();
            expect(reopened.get(select).text()).toBe('原文发送');
            expect(reopened.text()).toContain('未经脱敏的内容会发送给模型服务商');
        });
    });

    it('user opens model settings then the failure action is the last control before protection records', async () => {
        const wrapper = await mountSection();
        const rows = wrapper.findAll('.settings-row-group [data-settings-search-target]');

        expect(rows.at(-1)?.text()).toContain('脱敏失败时');
    });

    it('user switches to algorithmic rules then the failure action is hidden until model mode returns with the saved choice', async () => {
        await useSettingsStore().updatePrivacyFilterFailureAction('send-original');
        const wrapper = await mountSection();
        const select = '[data-testid="privacy-filter-failure-action"]';

        await selectMode(wrapper, 'rules');
        expect(wrapper.find(select).exists()).toBe(false);

        await selectMode(wrapper, 'model');
        expect(wrapper.get(select).text()).toBe('原文发送');
    });

    it('user reviews the basic controls then sees concise explanations and no mode recommendation badge', async () => {
        const wrapper = await mountSection();
        expect(wrapper.find('h2.settings-section-title').text()).toBe('基础');
        expect(wrapper.get('[role="radiogroup"]').attributes('aria-label')).toBe('保护模式');
        expect(wrapper.find('[data-testid="privacy-filter-mode-recommended"]').exists()).toBe(
            false
        );
        expect(
            wrapper.get('[data-settings-search-target="privacy-filter-scope"]').text()
        ).toContain('保护类别');
        expect(wrapper.text()).toContain('选择要识别和保护的敏感信息类型。');
        expect(
            wrapper.get('[data-settings-search-target="privacy-filter-masked-words"]').text()
        ).toContain('自定义敏感词');
        expect(wrapper.text()).toContain('添加需要始终遮罩的词语或短语。');
        expect(
            wrapper.get('[data-settings-search-target="privacy-filter-secret-prefixes"]').text()
        ).toContain('自定义密钥前缀');
        expect(wrapper.text()).toContain('识别以指定前缀开头的密钥和令牌。');
        expect(
            wrapper.get('[data-settings-search-target="privacy-filter-confidence"]').text()
        ).toContain('提高阈值可减少误报，也可能漏检信息。');
        expect(
            wrapper.get('[data-settings-search-target="privacy-filter-model-manager"]').text()
        ).toContain('识别模型');
        expect(
            wrapper.get('[data-settings-search-target="privacy-filter-mode"]').text()
        ).not.toContain('按上下文识别敏感信息');
    });

    it('user opens settings after a protected request then sees both modes below the chart and can review replacements at the bottom', async () => {
        const original = 'ada@example.test';
        const placeholder = '{{EMAIL_0123456789abcdef}}';
        mockTauriCommand('privacy_filter_records', [
            {
                id: 'settings-review',
                createdAt: Date.now(),
                mode: 'rules',
                outcome: 'protected',
                maskedCount: 1,
                categories: [{ kind: 'email', count: 1 }],
                modelName: 'Example Model',
            },
        ]);
        mockTauriCommand('privacy_filter_record_detail_ids', ['settings-review']);
        mockTauriCommand('privacy_filter_record_details', {
            values: [
                {
                    kind: 'email',
                    original,
                    placeholder,
                    count: 1,
                    matches: [{ id: 'email', count: 1 }],
                },
            ],
            texts: [placeholder],
            truncated: false,
        });
        const wrapper = await mountSection();
        const overview = wrapper.get('[aria-label="保护概览"]');
        expect(overview.get('h1').text()).toBe('隐私保护');
        expect(overview.text()).not.toContain('保护概览');
        const mode = wrapper.get('[role="radiogroup"][aria-label="保护模式"]');
        expect(mode.findAll('[role="radio"]').map((item) => item.attributes('aria-label'))).toEqual(
            ['本地模型', '算法规则']
        );
        const records = wrapper.get('[aria-labelledby="privacy-protection-records-title"]');
        expect(
            overview.get('[role="application"]').element.compareDocumentPosition(mode.element) &
                Node.DOCUMENT_POSITION_FOLLOWING
        ).toBeTruthy();
        expect(
            wrapper
                .get('#privacy-filter-scope-title')
                .element.compareDocumentPosition(records.element) & Node.DOCUMENT_POSITION_FOLLOWING
        ).toBeTruthy();
        expect(records.text()).toContain('Example Model');
        expect(records.text()).toContain('规则 / 邮箱');
        expect(records.text()).not.toContain('会话中也可悬停下划线文本查看替换情况');
        await records.get('[data-testid="privacy-protection-record-open"]').trigger('click');
        await flushPromises();
        expect(records.get('[data-testid="privacy-protection-value-original"]').text()).toBe(
            original
        );
        expect(records.get('[data-testid="privacy-protection-value-masked"]').text()).toBe(
            placeholder
        );
        const chart = overview.get('[role="application"]');
        await chart.trigger('keydown', { key: 'ArrowRight' });
        expect(overview.get('[data-testid="bar-chart-tooltip"]').text()).toMatch(/已脱敏\s*1/);
    });

    it.each([
        { label: 'installed', status: modelStatus({ installed: true }) },
        { label: 'not downloaded', status: modelStatus() },
        { label: 'downloading', status: modelStatus({ downloading: true }) },
    ])(
        'user opens a model selector $label then sees controls without redundant state or explanation text',
        async ({ status }) => {
            mockTauriCommand('privacy_filter_model_status', status);
            const wrapper = await mountSection();
            expect(wrapper.text()).not.toContain('已安装');
            expect(wrapper.text()).not.toContain('未下载');
            expect(wrapper.find('[data-testid="privacy-filter-model-installed"]').exists()).toBe(
                false
            );
            expect(wrapper.find('[data-testid="privacy-filter-model-downloading"]').exists()).toBe(
                false
            );
            await openModelOptions(wrapper);
            const list = document.querySelector<HTMLElement>('[role="listbox"]')!;
            expect(list.textContent).not.toContain('已安装');
            expect(list.textContent).not.toContain('中英文');
        }
    );

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

    it.each(['maskedWords', 'secretPrefixes'] as const)(
        'user pastes several values into %s then separate unique entries are saved without adding explanation controls',
        async (key) => {
            const store = useSettingsStore();
            store.privacyFilterSettings.useLocalModel = false;
            const wrapper = await mountSection();
            const input = wrapper.get<HTMLInputElement>(
                `[data-testid="privacy-filter-${key}-input"]`
            );
            await input.setValue('  alpha, beta，ALPHA, gamma  ');
            await input.element
                .closest('form')!
                .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            await flushPromises();
            expect(store.privacyFilterSettings[key]).toEqual(['alpha', 'beta', 'gamma']);
            expect(wrapper.findAll(`[data-testid="privacy-filter-${key}-item"]`)).toHaveLength(3);
            expect(input.element.value).toBe('');
        }
    );

    it('user adds a trimmed custom term once and can remove it from the saved list', async () => {
        const store = useSettingsStore();
        store.privacyFilterSettings.useLocalModel = false;
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
            let currentStatus = status;
            mockTauriCommand('privacy_filter_model_status', () => currentStatus);
            await store.updatePrivacyFilterSettings({
                ...store.privacyFilterSettings,
                enabled: false,
                categories: { ...store.privacyFilterSettings.categories, email: true },
                maskedWords: ['Project Nightfall'],
            });
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

            currentStatus = modelStatus({ installed: true });
            await enabled.trigger('click');
            await flushPromises();
            expect(store.privacyFilterSettings.enabled).toBe(true);
            expect(
                wrapper.get('[data-testid="privacy-filter-mode-rules"]').attributes('disabled')
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
        store.privacyFilterSettings.categories.email = true;
        store.privacyFilterSettings.maskedWords = ['Project Nightfall'];
        mockTauriCommand('privacy_filter_model_status', modelStatus({ installed: true }));
        const wrapper = await mountSection();
        expect(wrapper.get('h1').text()).toBe('隐私保护');
        expect(wrapper.text()).toContain('基于本地模型和规则遮罩关键文本信息，保护您的隐私');
        expect(wrapper.find('[data-testid="privacy-filter-preview-input"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="privacy-filter-preview-run"]').exists()).toBe(false);
        expect(
            wrapper.find('[data-settings-search-target="privacy-filter-local-model"]').exists()
        ).toBe(false);
        expect(
            wrapper.get('[data-testid="privacy-filter-mode-model"]').attributes('aria-checked')
        ).toBe('true');
        expect(wrapper.find('[data-testid="privacy-filter-maskedWords-input"]').exists()).toBe(
            true
        );
        expect(wrapper.find('[data-testid="privacy-filter-secretPrefixes-input"]').exists()).toBe(
            true
        );
        expect(wrapper.text()).toContain('保护类别');
        expect(wrapper.text()).toContain('选择要识别和保护的敏感信息类型。');
        expect(wrapper.text()).toContain('自定义敏感词');
        expect(wrapper.text()).toContain('添加需要始终遮罩的词语或短语。');
        expect(wrapper.text()).toContain('自定义密钥前缀');
        expect(wrapper.text()).toContain('识别以指定前缀开头的密钥和令牌。');
        expect(wrapper.text()).toContain('提高阈值可减少误报，也可能漏检信息。');
        expect(wrapper.text()).not.toContain('自定义规则');
        expect(wrapper.find('[data-testid="privacy-filter-download-source"]').exists()).toBe(false);
        await wrapper.get('[data-testid="privacy-filter-confidence-threshold"]').setValue('0.9');
        await wrapper.get('[data-testid="privacy-filter-category-privatePerson"]').trigger('click');
        await flushPromises();

        await selectMode(wrapper, 'rules');
        expect(
            wrapper.get('[data-testid="privacy-filter-mode-rules"]').attributes('aria-checked')
        ).toBe('true');
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

    it('user switches modes, then their own words and prefixes stay available in both', async () => {
        const wrapper = await mountSection();

        expect(wrapper.find('[data-testid="privacy-filter-maskedWords-input"]').exists()).toBe(
            true
        );
        expect(wrapper.find('[data-testid="privacy-filter-secretPrefixes-input"]').exists()).toBe(
            true
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
            true
        );
        expect(wrapper.find('[data-testid="privacy-filter-secretPrefixes-input"]').exists()).toBe(
            true
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
            wrapper.get('[data-testid="privacy-filter-mode-rules"]').attributes('disabled')
        ).toBeDefined();
    });

    it('user rapidly toggles while turning protection off then the pending disabled choice is saved once before another activation is allowed', async () => {
        const save = deferred<void>();
        interceptTauriInvoke(async (call, next) => {
            const request = (call.payload as { request?: DatabaseQueryRequest })?.request;
            const [key, value] = request?.params ?? [];
            if (
                call.cmd === 'database_query' &&
                key === 'privacy_filter_settings' &&
                typeof value === 'string' &&
                !JSON.parse(value).enabled
            )
                await save.promise;
            return next();
        });
        const wrapper = await mountSection();
        const toggle = wrapper.get('[data-testid="privacy-filter-enabled-toggle"]');
        await toggle.trigger('click');
        await flushPromises();
        expect(toggle.attributes('disabled')).toBeDefined();
        await toggle.trigger('click');
        save.resolve();
        await flushPromises();
        expect(useSettingsStore().privacyFilterSettings.enabled).toBe(false);
        expect(getTauriInvokeCalls('privacy_filter_download_model')).toHaveLength(0);
        expect(toggle.attributes('disabled')).toBeUndefined();
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
        expect(wrapper.find('[data-testid="privacy-filter-model-downloading"]').exists()).toBe(
            false
        );
        expect(
            document.querySelector('[role="listbox"] [role="status"]')?.getAttribute('aria-label')
        ).toBe('正在下载');
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

describe('given privacy protection is off', () => {
    beforeEach(async () => {
        const store = useSettingsStore();
        await store.updatePrivacyFilterSettings({
            ...store.privacyFilterSettings,
            enabled: false,
            useLocalModel: false,
        });
        await store.updatePrivacyFilterModelId('openai-privacy-filter');
    });

    it('user opens protection settings then sees no recommendation badge on either mode card', async () => {
        const wrapper = await mountSection();
        expect(wrapper.find('[data-testid="privacy-filter-mode-recommended"]').exists()).toBe(
            false
        );
    });

    it('user accepts a newer enabled rules configuration while local verification waits then the stale activation cannot turn protection off', async () => {
        mockTauriCommand('privacy_filter_model_status', modelStatus({ installed: true }));
        const verification = deferred<unknown>();
        mockTauriCommand('privacy_filter_detect', () => verification.promise);
        const wrapper = await mountSection();
        await wrapper.get('[data-testid="privacy-filter-enabled-toggle"]').trigger('click');
        await flushPromises();
        const store = useSettingsStore();
        await store.updatePrivacyFilterSettings({
            ...store.privacyFilterSettings,
            enabled: true,
            useLocalModel: false,
        });
        await flushPromises();
        verification.resolve([[]]);
        await flushPromises();
        expect(store.privacyFilterSettings).toMatchObject({ enabled: true, useLocalModel: false });
        expect(
            wrapper.get('[data-testid="privacy-filter-mode-rules"]').attributes('aria-checked')
        ).toBe('true');
    });

    describe('given the disabled settings page is ready without a model', () => {
        let wrapper: Awaited<ReturnType<typeof mountSection>>;
        beforeEach(async () => {
            wrapper = await mountSection();
        });

        it('user requests protection without a model then sees the manual download actions without saving the request', async () => {
            const store = useSettingsStore();
            const saved = JSON.stringify(store.privacyFilterSettings);
            await wrapper.get('[data-testid="privacy-filter-enabled-toggle"]').trigger('click');
            await flushPromises();

            expect(JSON.stringify(store.privacyFilterSettings)).toBe(saved);
            expect(store.privacyFilterModelId).toBe('openai-privacy-filter');
            expect(getTauriInvokeCalls('privacy_filter_download_model')).toHaveLength(0);
            expect(getTauriInvokeCalls('privacy_filter_detect')).toHaveLength(0);
            expect(
                wrapper
                    .get('[data-testid="privacy-filter-enabled-toggle"]')
                    .attributes('aria-checked')
            ).toBe('true');
            expect(
                wrapper.get('[data-settings-search-target="privacy-filter-model-manager"]').text()
            ).toContain('请点击下载模型');
            expect(pageControl('privacy-filter-download-model').element.matches(':disabled')).toBe(
                false
            );
            expect(
                wrapper
                    .get('[data-testid="privacy-filter-confidence-threshold"]')
                    .element.matches(':disabled')
            ).toBe(true);
            expect(wrapper.find('[data-testid="privacy-filter-activation-status"]').exists()).toBe(
                false
            );
            expect(wrapper.find('[data-testid="privacy-filter-activation-cancel"]').exists()).toBe(
                false
            );
        });
    });

    it.each(['astrlink-guard-int8', 'openai-privacy-filter', 'openmed-privacy-filter'] as const)(
        'user downloads %s then protection activates automatically only after local verification succeeds',
        async (requestedModelId) => {
            const download = deferred<void>();
            const verification = deferred<unknown>();
            let status = modelStatus();
            mockTauriCommand('privacy_filter_model_status', (payload?: InvokeArgs) => {
                const modelId = (payload as { modelId: PrivacyFilterModelStatus['modelId'] })
                    .modelId;
                return modelId === requestedModelId
                    ? { ...status, modelId }
                    : modelStatus({ modelId });
            });
            mockTauriCommand('privacy_filter_download_model', () => {
                status = modelStatus({ downloading: true });
                return download.promise;
            });
            mockTauriCommand('privacy_filter_detect', () => verification.promise);
            const store = useSettingsStore();
            const wrapper = await mountSection();
            await wrapper.get('[data-testid="privacy-filter-enabled-toggle"]').trigger('click');
            await flushPromises();

            expect(store.privacyFilterSettings.enabled).toBe(false);
            expect(getTauriInvokeCalls('privacy_filter_download_model')).toHaveLength(0);
            const option = pageControl(`privacy-filter-model-${requestedModelId}`);
            const group = new DOMWrapper(option.element.closest<HTMLElement>('[role="group"]')!);
            await group.get('[data-testid="privacy-filter-download-model"]').trigger('click');
            await flushPromises();
            expect(
                wrapper.get('[data-testid="privacy-filter-mode-model"]').attributes('aria-checked')
            ).toBe('true');
            expect(
                getTauriInvokeCalls('privacy_filter_download_model').map((call) => call.payload)
            ).toEqual([{ modelId: requestedModelId, source: 'auto' }]);
            status = modelStatus({ installed: true });
            download.resolve();
            await flushPromises();
            expect(store.privacyFilterSettings.enabled).toBe(false);
            expect(
                wrapper.get('[data-testid="privacy-filter-enabled-toggle"]').attributes('aria-busy')
            ).toBe('true');
            const scans = getTauriInvokeCalls('privacy_filter_detect');
            expect(scans).toHaveLength(1);
            expect(scans[0]?.payload).toMatchObject({ modelId: requestedModelId });
            expect((scans[0]?.payload as { texts: string[] }).texts[0]?.length).toBeGreaterThan(0);
            await emit(PRIVACY_FILTER_DOWNLOAD_PROGRESS_EVENT, {
                modelId: requestedModelId,
                downloadedBytes: 1024,
                totalBytes: 1024,
                currentFile: 'model.onnx',
            });
            await flushPromises();
            expect(getTauriInvokeCalls('privacy_filter_detect')).toHaveLength(1);
            verification.resolve([[]]);
            await flushPromises();
            expect(store.privacyFilterSettings.enabled).toBe(true);
            expect(store.privacyFilterSettings.useLocalModel).toBe(true);
            expect(store.privacyFilterModelId).toBe(requestedModelId);
            expect(wrapper.find('[data-testid="privacy-filter-activation-status"]').exists()).toBe(
                false
            );
        }
    );

    it('user retries a failed manual download then protection activates after the successful download without a second enable click', async () => {
        const store = useSettingsStore();
        const saved = JSON.stringify(store.privacyFilterSettings);
        let status = modelStatus();
        mockTauriCommand('privacy_filter_model_status', () => status);
        mockTauriCommand('privacy_filter_download_model', () => {
            throw new Error('Connection unavailable');
        });
        const wrapper = await mountSection();
        const toggle = wrapper.get('[data-testid="privacy-filter-enabled-toggle"]');
        await toggle.trigger('click');
        await flushPromises();
        await pageControl('privacy-filter-download-model').trigger('click');
        await flushPromises();
        expect(JSON.stringify(store.privacyFilterSettings)).toBe(saved);
        expect(store.privacyFilterModelId).toBe('openai-privacy-filter');
        expect(toggle.attributes('aria-checked')).toBe('true');
        expect(getTauriInvokeCalls('privacy_filter_detect')).toHaveLength(0);
        await ensureModelOptions(wrapper);
        expect(pageControl('privacy-filter-download-model').element.matches(':disabled')).toBe(
            false
        );

        mockTauriCommand('privacy_filter_download_model', () => {
            status = modelStatus({ installed: true });
        });
        await pageControl('privacy-filter-download-model').trigger('click');
        await flushPromises();
        expect(store.privacyFilterSettings.enabled).toBe(true);
        expect(store.privacyFilterSettings.useLocalModel).toBe(true);
        expect(store.privacyFilterModelId).toBe('astrlink-guard-int8');
    });

    it('user changes the saved preferences while verification is pending then its late result cannot enable protection or overwrite the new preferences', async () => {
        const verification = deferred<unknown>();
        mockTauriCommand('privacy_filter_model_status', modelStatus({ installed: true }));
        mockTauriCommand('privacy_filter_detect', () => verification.promise);
        const store = useSettingsStore();
        const wrapper = await mountSection();
        await wrapper.get('[data-testid="privacy-filter-enabled-toggle"]').trigger('click');
        await flushPromises();
        const updated = { ...store.privacyFilterSettings, confidenceThreshold: 0.9 };
        await store.updatePrivacyFilterSettings(updated);
        await flushPromises();
        verification.resolve([[]]);
        await flushPromises();
        expect(store.privacyFilterSettings).toEqual(updated);
        expect(store.privacyFilterModelId).toBe('openai-privacy-filter');
        expect(
            wrapper.get('[data-testid="privacy-filter-enabled-toggle"]').attributes('aria-checked')
        ).toBe('false');
    });

    it('user enables twice with an installed model then gets one verification and no duplicate download', async () => {
        const verification = deferred<unknown>();
        mockTauriCommand('privacy_filter_model_status', modelStatus({ installed: true }));
        mockTauriCommand('privacy_filter_detect', () => verification.promise);
        const wrapper = await mountSection();
        const toggle = wrapper.get('[data-testid="privacy-filter-enabled-toggle"]');
        await toggle.trigger('click');
        await toggle.trigger('click');
        await flushPromises();
        expect(useSettingsStore().privacyFilterSettings.enabled).toBe(false);
        expect(getTauriInvokeCalls('privacy_filter_download_model')).toHaveLength(0);
        expect(getTauriInvokeCalls('privacy_filter_detect')).toHaveLength(1);
        expect(
            wrapper.get('[data-testid="privacy-filter-mode-rules"]').element.matches(':disabled')
        ).toBe(true);
        verification.resolve([[]]);
        await flushPromises();
        expect(useSettingsStore().privacyFilterSettings.enabled).toBe(true);
    });

    it.each(['switch', 'download action'])(
        'user cancels preparation with the %s then a late download cannot activate protection and a later retry succeeds',
        async (action) => {
            const download = deferred<void>();
            let status = modelStatus();
            mockTauriCommand('privacy_filter_model_status', () => status);
            mockTauriCommand('privacy_filter_download_model', () => {
                status = modelStatus({ downloading: true });
                return download.promise;
            });
            mockTauriCommand('privacy_filter_cancel_model_download', undefined);
            const wrapper = await mountSection();
            await wrapper.get('[data-testid="privacy-filter-enabled-toggle"]').trigger('click');
            await flushPromises();
            await pageControl('privacy-filter-download-model').trigger('click');
            await flushPromises();
            if (action === 'switch')
                await wrapper.get('[data-testid="privacy-filter-enabled-toggle"]').trigger('click');
            else await pageControl('privacy-filter-cancel-download').trigger('click');
            await flushPromises();
            expect(getTauriInvokeCalls('privacy_filter_cancel_model_download')).toHaveLength(
                action === 'switch' ? 0 : 1
            );
            status = modelStatus({ installed: true });
            download.resolve();
            await flushPromises();
            expect(useSettingsStore().privacyFilterSettings.enabled).toBe(false);
            expect(getTauriInvokeCalls('privacy_filter_detect')).toHaveLength(0);
            expect(wrapper.find('[role="alert"]').exists()).toBe(false);
            await wrapper.get('[data-testid="privacy-filter-enabled-toggle"]').trigger('click');
            await flushPromises();
            expect(useSettingsStore().privacyFilterSettings.enabled).toBe(true);
        }
    );

    it('user leaves during verification then its late result cannot turn protection on', async () => {
        const verification = deferred<unknown>();
        mockTauriCommand('privacy_filter_model_status', modelStatus({ installed: true }));
        mockTauriCommand('privacy_filter_detect', () => verification.promise);
        const wrapper = await mountSection();
        await wrapper.get('[data-testid="privacy-filter-enabled-toggle"]').trigger('click');
        await flushPromises();
        wrapper.unmount();
        verification.resolve([[]]);
        await flushPromises();
        expect(useSettingsStore().privacyFilterSettings.enabled).toBe(false);
        expect(useSettingsStore().privacyFilterModelId).toBe('openai-privacy-filter');
    });

    it('user leaves settings during a manual download then its late completion cannot activate protection', async () => {
        const download = deferred<void>();
        mockTauriCommand('privacy_filter_download_model', () => download.promise);
        mockTauriCommand('privacy_filter_cancel_model_download', undefined);
        const wrapper = await mountSection();
        await wrapper.get('[data-testid="privacy-filter-enabled-toggle"]').trigger('click');
        await flushPromises();
        await pageControl('privacy-filter-download-model').trigger('click');
        await flushPromises();
        wrapper.unmount();
        download.resolve();
        await flushPromises();
        expect(getTauriInvokeCalls('privacy_filter_cancel_model_download')).toHaveLength(0);
        expect(useSettingsStore().privacyFilterSettings.enabled).toBe(false);
        expect(getTauriInvokeCalls('privacy_filter_detect')).toHaveLength(0);
    });

    it('user enables during an existing download then its completion activates protection without starting a second download', async () => {
        let status = modelStatus({ downloading: true });
        mockTauriCommand('privacy_filter_model_status', () => status);
        const wrapper = await mountSection();
        await wrapper.get('[data-testid="privacy-filter-enabled-toggle"]').trigger('click');
        await flushPromises();
        expect(useSettingsStore().privacyFilterSettings.enabled).toBe(false);
        expect(getTauriInvokeCalls('privacy_filter_download_model')).toHaveLength(0);
        status = modelStatus({ installed: true });
        await emit(PRIVACY_FILTER_DOWNLOAD_PROGRESS_EVENT, {
            modelId: 'astrlink-guard-int8',
            downloadedBytes: 1024,
            totalBytes: 1024,
            currentFile: 'model.onnx',
        });
        await flushPromises();
        expect(useSettingsStore().privacyFilterSettings.enabled).toBe(true);
        expect(getTauriInvokeCalls('privacy_filter_cancel_model_download')).toHaveLength(0);
    });

    it('user cancels waiting for another download then that download stays running and cannot activate protection', async () => {
        let status = modelStatus({ downloading: true });
        mockTauriCommand('privacy_filter_model_status', () => status);
        const wrapper = await mountSection();
        await wrapper.get('[data-testid="privacy-filter-enabled-toggle"]').trigger('click');
        await flushPromises();
        await wrapper.get('[data-testid="privacy-filter-enabled-toggle"]').trigger('click');
        await flushPromises();
        status = modelStatus({ installed: true });
        await emit(PRIVACY_FILTER_DOWNLOAD_PROGRESS_EVENT, {
            modelId: 'astrlink-guard-int8',
            downloadedBytes: 1024,
            totalBytes: 1024,
            currentFile: 'model.onnx',
        });
        await flushPromises();
        expect(useSettingsStore().privacyFilterSettings.enabled).toBe(false);
        expect(getTauriInvokeCalls('privacy_filter_cancel_model_download')).toHaveLength(0);
        expect(getTauriInvokeCalls('privacy_filter_detect')).toHaveLength(0);
        expect(wrapper.find('[data-testid="privacy-filter-activation-status"]').exists()).toBe(
            false
        );
    });

    it.each(['selection', 'enable'])(
        'user encounters a failed %s save then stays disabled and can retry successfully',
        async (step) => {
            mockTauriCommand('privacy_filter_model_status', modelStatus({ installed: true }));
            let fail = true;
            interceptTauriInvoke((call, next) => {
                const request = (call.payload as { request?: DatabaseQueryRequest })?.request;
                const [key, value] = request?.params ?? [];
                const config =
                    key === 'privacy_filter_settings' && typeof value === 'string'
                        ? JSON.parse(value)
                        : null;
                if (
                    fail &&
                    call.cmd === 'database_query' &&
                    ((step === 'selection' &&
                        key === 'privacy_filter_model_id' &&
                        value === 'astrlink-guard-int8') ||
                        (step === 'enable' && config?.enabled))
                )
                    throw new Error('Disk unavailable');
                return next();
            });
            const wrapper = await mountSection();
            await wrapper.get('[data-testid="privacy-filter-enabled-toggle"]').trigger('click');
            await flushPromises();
            expect(useSettingsStore().privacyFilterSettings.enabled).toBe(false);
            expect(wrapper.get('[data-testid="privacy-filter-activation-error"]').text()).toContain(
                '未启用'
            );
            expect(
                wrapper.get('[data-testid="privacy-filter-enabled-toggle"]').attributes('disabled')
            ).toBeUndefined();
            fail = false;
            await wrapper.get('[data-testid="privacy-filter-enabled-toggle"]').trigger('click');
            await flushPromises();
            expect(useSettingsStore().privacyFilterSettings.enabled).toBe(true);
        }
    );

    it('user leaves while the enabled setting is being saved then the late activation is reverted', async () => {
        mockTauriCommand('privacy_filter_model_status', modelStatus({ installed: true }));
        const save = deferred<void>();
        interceptTauriInvoke(async (call, next) => {
            const request = (call.payload as { request?: DatabaseQueryRequest })?.request;
            const [key, value] = request?.params ?? [];
            if (
                call.cmd === 'database_query' &&
                key === 'privacy_filter_settings' &&
                typeof value === 'string' &&
                JSON.parse(value).enabled
            )
                await save.promise;
            return next();
        });
        const wrapper = await mountSection();
        await wrapper.get('[data-testid="privacy-filter-enabled-toggle"]').trigger('click');
        await flushPromises();
        expect(
            wrapper.get('[data-testid="privacy-filter-enabled-toggle"]').attributes('aria-busy')
        ).toBe('true');
        wrapper.unmount();
        save.resolve();
        await flushPromises();
        expect(useSettingsStore().privacyFilterSettings.enabled).toBe(false);
    });

    it.each(['status', 'verification', 'invalid response'])(
        'user encounters a failed %s then protection stays off and an explicit retry can succeed',
        async (failure) => {
            mockTauriCommand('privacy_filter_model_status', () => {
                if (failure === 'status') throw new Error('Status unavailable');
                return modelStatus({ installed: true });
            });
            mockTauriCommand('privacy_filter_detect', () => {
                if (failure === 'verification') throw new Error('Invalid model');
                return undefined;
            });
            const wrapper = await mountSection();
            await wrapper.get('[data-testid="privacy-filter-enabled-toggle"]').trigger('click');
            await flushPromises();
            expect(useSettingsStore().privacyFilterSettings.enabled).toBe(false);
            expect(wrapper.get('[data-testid="privacy-filter-activation-error"]').text()).toContain(
                '未启用'
            );
            mockTauriCommand('privacy_filter_model_status', modelStatus({ installed: true }));
            mockTauriCommand('privacy_filter_detect', [[]]);
            await wrapper.get('[data-testid="privacy-filter-enabled-toggle"]').trigger('click');
            await flushPromises();
            expect(useSettingsStore().privacyFilterSettings.enabled).toBe(true);
            expect(wrapper.find('[data-testid="privacy-filter-activation-error"]').exists()).toBe(
                false
            );
        }
    );
});
