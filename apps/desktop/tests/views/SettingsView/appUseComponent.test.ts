import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import {
    type AppUseToolConfig,
    DEFAULT_APP_USE_TOOL_CONFIG,
} from '@/services/BuiltInToolService/tools/appUse';
import AppUseSection from '@/views/SettingsView/components/AppUse/index.vue';

const queries = vi.hoisted(() => ({
    findAllBuiltInTools: vi.fn(),
    updateBuiltInTool: vi.fn(),
}));

vi.mock('@database/queries', () => queries);

vi.mock('@components/AlertMessage.vue', () => ({
    default: {
        name: 'AlertMessageStub',
        template: '<div />',
        methods: {
            error: vi.fn(),
            success: vi.fn(),
            warning: vi.fn(),
        },
    },
}));

vi.mock('@components/AppIcon.vue', () => ({
    default: {
        name: 'AppIconStub',
        props: ['name'],
        template: '<span data-testid="app-icon" :data-name="name" />',
    },
}));

vi.mock('@/views/SettingsView/components/BuiltInTools/components/BuiltInToolLogViewer.vue', () => ({
    default: {
        name: 'BuiltInToolLogViewerStub',
        props: ['tool'],
        template: '<div data-testid="settings-app-use-log-viewer">{{ tool.tool_id }}</div>',
    },
}));

type BuiltInToolStub = {
    id: number;
    tool_id: string;
    display_name: string;
    description: string | null;
    enabled: number;
    risk_level: 'high';
    config_json: string | null;
    last_used_at: string | null;
    created_at: string;
    updated_at: string;
};

function appUseConfig(patch: Partial<AppUseToolConfig> = {}): AppUseToolConfig {
    return {
        ...DEFAULT_APP_USE_TOOL_CONFIG,
        ...patch,
        adapters: {
            ...DEFAULT_APP_USE_TOOL_CONFIG.adapters,
            ...(patch.adapters ?? {}),
        },
    };
}

function makeTool(id: number, toolId: string, config: AppUseToolConfig): BuiltInToolStub {
    return {
        id,
        tool_id: toolId,
        display_name: toolId,
        description: null,
        enabled: 0,
        risk_level: 'high',
        config_json: JSON.stringify(config),
        last_used_at: null,
        created_at: '',
        updated_at: '',
    };
}

function parseSavedConfig(callIndex: number): AppUseToolConfig {
    const patch = queries.updateBuiltInTool.mock.calls[callIndex]?.[1];
    return JSON.parse(patch.config_json);
}

describe('Settings App Use section', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setLocale('en-US');
        const initialConfig = appUseConfig({
            adapters: {
                ...DEFAULT_APP_USE_TOOL_CONFIG.adapters,
                wps_writer: true,
            },
        });
        const tools = [
            makeTool(1, 'app_session', initialConfig),
            makeTool(2, 'app_observe', initialConfig),
            makeTool(3, 'app_act', initialConfig),
        ];

        queries.findAllBuiltInTools.mockResolvedValue(tools);
        queries.updateBuiltInTool.mockImplementation(async (id: number, patch: object) => ({
            ...tools.find((tool) => tool.id === id),
            ...patch,
        }));
    });

    it('loads the shared App Use config into a dedicated settings panel', async () => {
        const wrapper = mount(AppUseSection);

        await flushPromises();

        expect(wrapper.get('[data-testid="settings-app-use-section"]').text()).toContain('App Use');
        expect(
            wrapper.get('[data-testid="settings-app-use-mode-read-only"]').attributes()
        ).toHaveProperty('aria-pressed', 'true');
        expect(
            wrapper.get('[data-testid="settings-app-use-adapter-wps_writer"]').attributes()
        ).toHaveProperty('aria-pressed', 'true');
        expect(
            wrapper.get('[data-testid="settings-app-use-adapter-office_word"]').attributes()
        ).toHaveProperty('aria-pressed', 'false');
    });

    it('saves mode and adapter changes to all three App Use tools', async () => {
        const wrapper = mount(AppUseSection);
        await flushPromises();

        await wrapper.get('[data-testid="settings-app-use-mode-interactive"]').trigger('click');
        await flushPromises();

        expect(queries.updateBuiltInTool).toHaveBeenNthCalledWith(1, 1, {
            config_json: expect.any(String),
        });
        expect(queries.updateBuiltInTool).toHaveBeenNthCalledWith(2, 2, {
            config_json: expect.any(String),
        });
        expect(queries.updateBuiltInTool).toHaveBeenNthCalledWith(3, 3, {
            config_json: expect.any(String),
        });
        expect(parseSavedConfig(0).mode).toBe('interactive');

        queries.updateBuiltInTool.mockClear();
        await wrapper.get('[data-testid="settings-app-use-adapter-office_word"]').trigger('click');
        await flushPromises();

        expect(parseSavedConfig(0).adapters.office_word).toBe(true);
        expect(parseSavedConfig(0).adapters.wps_writer).toBe(true);
    });

    it('enables or disables every App Use tool from the master switch', async () => {
        const wrapper = mount(AppUseSection);
        await flushPromises();

        await wrapper.get('[data-testid="settings-app-use-enabled-toggle"]').trigger('click');
        await flushPromises();

        expect(queries.updateBuiltInTool).toHaveBeenNthCalledWith(1, 1, { enabled: 1 });
        expect(queries.updateBuiltInTool).toHaveBeenNthCalledWith(2, 2, { enabled: 1 });
        expect(queries.updateBuiltInTool).toHaveBeenNthCalledWith(3, 3, { enabled: 1 });
    });

    it('keeps controls usable when the master switch save fails', async () => {
        queries.updateBuiltInTool.mockRejectedValueOnce(new Error('save failed'));
        const wrapper = mount(AppUseSection);
        await flushPromises();

        await wrapper.get('[data-testid="settings-app-use-enabled-toggle"]').trigger('click');
        await flushPromises();

        expect(queries.updateBuiltInTool).toHaveBeenCalledTimes(3);
        expect(
            wrapper.get('[data-testid="settings-app-use-enabled-toggle"]').attributes()
        ).not.toHaveProperty('disabled');
    });

    it('saves safety limits from the dedicated settings tab to all App Use tools', async () => {
        const wrapper = mount(AppUseSection);
        await flushPromises();

        expect(wrapper.find('[data-testid="settings-app-use-background-toggle"]').exists()).toBe(
            false
        );

        queries.updateBuiltInTool.mockClear();
        await wrapper.get('[data-testid="settings-app-use-timeout-ms"]').setValue('45000');
        await wrapper.get('[data-testid="settings-app-use-timeout-ms"]').trigger('change');
        await flushPromises();

        expect(parseSavedConfig(0).timeoutMs).toBe(45000);
        expect(queries.updateBuiltInTool).toHaveBeenCalledTimes(3);

        queries.updateBuiltInTool.mockClear();
        await wrapper.get('[data-testid="settings-app-use-max-output-chars"]').setValue('24000');
        await wrapper.get('[data-testid="settings-app-use-max-output-chars"]').trigger('change');
        await flushPromises();

        expect(parseSavedConfig(0).maxOutputChars).toBe(24000);
        expect(queries.updateBuiltInTool).toHaveBeenCalledTimes(3);
    });

    it('does not save unchanged mode or invalid numeric limits', async () => {
        const wrapper = mount(AppUseSection);
        await flushPromises();

        queries.updateBuiltInTool.mockClear();
        await wrapper.get('[data-testid="settings-app-use-mode-read-only"]').trigger('click');
        await flushPromises();

        expect(queries.updateBuiltInTool).not.toHaveBeenCalled();

        await wrapper.get('[data-testid="settings-app-use-timeout-ms"]').setValue('not-a-number');
        await wrapper.get('[data-testid="settings-app-use-timeout-ms"]').trigger('change');
        await flushPromises();

        expect(queries.updateBuiltInTool).not.toHaveBeenCalled();
    });

    it('shows the full App Use phase plan as read-only planning', async () => {
        const wrapper = mount(AppUseSection);
        await flushPromises();

        const sectionText = wrapper.get('[data-testid="settings-app-use-section"]').text();
        expect(sectionText).toContain('Phase plan');
        expect(sectionText).toContain('raw scripts');
        expect(sectionText).toContain('raw automation fallbacks');
        expect(sectionText).toContain('P6: Computer Use boundary');
        expect(sectionText).toContain('Out of scope');
        expect(sectionText).not.toContain('UI Automation fallback');
        expect(
            wrapper.get('[data-testid="settings-app-use-advanced-p0-definition-framework"]').text()
        ).toContain('Current');
        expect(
            wrapper.get('[data-testid="settings-app-use-advanced-p1-settings"]').text()
        ).toContain('Current');
        expect(
            wrapper.get('[data-testid="settings-app-use-advanced-p2-discovery"]').text()
        ).toContain('Current');
        expect(
            wrapper.get('[data-testid="settings-app-use-advanced-p3-structured-observe"]').text()
        ).toContain('Current');
        expect(
            wrapper.get('[data-testid="settings-app-use-advanced-p4-approval-governance"]').text()
        ).toContain('Current');
        expect(
            wrapper.get('[data-testid="settings-app-use-advanced-p5-office-wps-actions"]').text()
        ).toContain('Current');
        expect(
            wrapper.get('[data-testid="settings-app-use-advanced-p6-computer-use-boundary"]').text()
        ).toContain('Out of scope');
        expect(
            wrapper.get('[data-testid="settings-app-use-advanced-p7-advanced-workflows"]').text()
        ).toContain('Planned');
        expect(
            wrapper.get('[data-testid="settings-app-use-advanced-p8-adapter-extension"]').text()
        ).toContain('Planned');

        queries.updateBuiltInTool.mockClear();
        await wrapper
            .get('[data-testid="settings-app-use-advanced-p7-advanced-workflows"]')
            .trigger('click');
        await flushPromises();

        expect(queries.updateBuiltInTool).not.toHaveBeenCalled();
    });

    it('keeps localized App Use naming and neutral safety copy', async () => {
        setLocale('zh-CN');
        const wrapper = mount(AppUseSection);
        await flushPromises();

        const sectionText = wrapper.get('[data-testid="settings-app-use-section"]').text();
        expect(sectionText).toContain('软件控制');
        expect(sectionText).toContain('原始脚本');
        expect(sectionText).toContain('原始自动化兜底');
        expect(sectionText).toContain('P6：Computer Use 边界');
        expect(sectionText).toContain('不属于软件控制');
        expect(sectionText).not.toContain('UI Automation fallback');
    });

    it('clamps out-of-range safety limits before saving', async () => {
        const wrapper = mount(AppUseSection);
        await flushPromises();

        await wrapper.get('[data-testid="settings-app-use-timeout-ms"]').setValue('250');
        await wrapper.get('[data-testid="settings-app-use-timeout-ms"]').trigger('change');
        await flushPromises();

        expect(parseSavedConfig(0).timeoutMs).toBe(1000);

        queries.updateBuiltInTool.mockClear();
        await wrapper.get('[data-testid="settings-app-use-max-output-chars"]').setValue('500000');
        await wrapper.get('[data-testid="settings-app-use-max-output-chars"]').trigger('change');
        await flushPromises();

        expect(parseSavedConfig(0).maxOutputChars).toBe(50000);
    });

    it('keeps App Use execution logs reachable from the dedicated tab', async () => {
        const wrapper = mount(AppUseSection);
        await flushPromises();

        const logsTab = wrapper
            .findAll('button')
            .find((button) => button.text().includes('Call logs'));
        expect(logsTab).toBeTruthy();
        await logsTab?.trigger('click');
        await flushPromises();

        expect(wrapper.find('[data-testid="settings-app-use-logs"]').exists()).toBe(true);
        expect(wrapper.get('[data-testid="settings-app-use-log-viewer"]').text()).toBe('app_act');

        await wrapper.get('[data-testid="settings-app-use-log-tool-app_observe"]').trigger('click');
        await flushPromises();

        expect(wrapper.get('[data-testid="settings-app-use-log-viewer"]').text()).toBe(
            'app_observe'
        );
    });
});
