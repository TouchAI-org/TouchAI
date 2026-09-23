import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

import { setLocale } from '@/i18n';
import { createDomLocalizer } from '@/i18n/domLocalizer';
import BashToolConfig from '@/views/SettingsView/components/BuiltInTools/components/BashToolConfig.vue';
import BuiltInToolList from '@/views/SettingsView/components/BuiltInTools/components/BuiltInToolList.vue';
import BuiltInToolLogViewer from '@/views/SettingsView/components/BuiltInTools/components/BuiltInToolLogViewer.vue';
import UpgradeModelToolConfig from '@/views/SettingsView/components/BuiltInTools/components/UpgradeModelToolConfig.vue';
import {
    type BuiltInToolEntity,
    type BuiltInToolLogEntity,
    formatToolLastUsed,
    getBuiltInToolSummary,
    isBuiltInToolVisibleInSettings,
    usesBuiltInToolEmptyConfig,
} from '@/views/SettingsView/components/BuiltInTools/types';
import {
    getBuiltInToolApprovalStateText,
    getToolLogStatusText,
} from '@/views/SettingsView/components/common/toolLogStatus';
import ToolLogStatusBadge from '@/views/SettingsView/components/common/ToolLogStatusBadge.vue';

const { findBuiltInToolLogsByToolIdMock, findModelsWithProviderMock, dialogOpenMock } = vi.hoisted(
    () => ({
        findBuiltInToolLogsByToolIdMock: vi.fn(),
        findModelsWithProviderMock: vi.fn(),
        dialogOpenMock: vi.fn(),
    })
);

vi.mock('@/i18n/textMap', () => {
    const zhToEnTextMap: Record<string, string> = {
        执行终端命令: 'Execute terminal commands',
        搜索本机文件: 'Search local files',
        '读取本地文件或目录，支持图片与 PDF':
            'Read local files or folders, including images and PDFs',
        读取和修改应用设置: 'Read and modify application settings',
        抓取网页并提取易读文本: 'Fetch web pages and extract readable text',
        升级当前请求模型: 'Upgrade the current request model',
        聊天内联可交互可视化: 'Inline interactive visualization in chat',
        '读取 ShowWidget 规范': 'Read the ShowWidget specification',
        暂无描述: 'No description',
        尚未调用: 'Not called yet',
        成功: 'Success',
        错误: 'Error',
        超时: 'Timed out',
        待审批: 'Pending',
        已批准: 'Approved',
        已拒绝: 'Rejected',
        已取消: 'Cancelled',
        待处理: 'Pending',
        进行中: 'In progress',
        暂无可配置的内置工具: 'No configurable built-in tools yet',
        网关注册完成后会自动展示在这里:
            'Tools will appear here after gateway registration completes',
        '启用/禁用': 'Enable/disable',
        自动: 'Automatic',
        每次询问: 'Ask every time',
        完全访问: 'Full access',
        执行与审批: 'Execution and approval',
        默认工作目录: 'Default working directory',
        允许工作目录: 'Allowed working directories',
        未设置时运行时默认桌面: 'Defaults to Desktop at runtime when unset',
        未设置时运行时允许全部路径: 'Allows all paths at runtime when unset',
        选择目录: 'Choose folder',
        '超时上限（毫秒）': 'Timeout limit (ms)',
        '输出上限（字符）': 'Output limit (characters)',
        全部: 'All',
        '搜索日志...': 'Search logs...',
        未找到匹配的日志: 'No matching logs',
        暂无日志: 'No logs yet',
        尝试其他搜索关键词: 'Try another search keyword',
        迭代: 'Iteration',
        加载更多: 'Load more',
        '加载中...': 'Loading...',
        '调用 ID：': 'Call ID:',
        会话: 'Session:',
        '会话：': 'Session:',
        '消息：': 'Message:',
        '审批：': 'Approval:',
        模型升级链: 'Model upgrade chain',
        服务商: 'Provider',
        搜索服务商: 'Search providers',
        没有可选服务商: 'No available providers',
        '{count} 个可选模型': '{count} available models',
    };

    return {
        zhToEnTextMap,
        hasTextTranslation: (text: string) =>
            Object.prototype.hasOwnProperty.call(zhToEnTextMap, text),
    };
});

vi.mock('@database/queries', () => ({
    findBuiltInToolLogsByToolId: findBuiltInToolLogsByToolIdMock,
    findModelsWithProvider: findModelsWithProviderMock,
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
    open: dialogOpenMock,
}));

vi.mock('@/services/BuiltInToolService/tools/bash', () => ({
    DEFAULT_BASH_TOOL_CONFIG: {
        approvalMode: 'high_risk',
        defaultWorkingDirectory: '',
        allowedWorkingDirectories: [],
        timeoutMs: 30000,
        maxOutputChars: 20000,
    },
    parseBashToolConfig: vi.fn(() => ({
        approvalMode: 'high_risk',
        defaultWorkingDirectory: '',
        allowedWorkingDirectories: [],
        timeoutMs: 30000,
        maxOutputChars: 20000,
    })),
}));

vi.mock('@/services/BuiltInToolService/tools/upgradeModel/config', () => ({
    parseUpgradeModelToolConfig: vi.fn(() => ({
        chain: [],
    })),
    serializeUpgradeModelToolConfig: vi.fn((config: { chain: unknown[] }) =>
        JSON.stringify(config)
    ),
}));

vi.mock('@services/EventService', () => ({
    AppEvent: {
        AI_MODELS_UPDATED: 'ai_models_updated',
    },
    eventService: {
        on: vi.fn(async () => vi.fn()),
    },
}));

vi.mock('@components/AppIcon.vue', () => ({
    default: {
        name: 'AppIcon',
        props: ['name'],
        template: '<span data-testid="app-icon" />',
    },
}));

vi.mock('@components/ToolLogContent.vue', () => ({
    default: {
        name: 'ToolLogContent',
        props: ['input', 'output', 'error', 'isError'],
        template:
            '<div data-testid="tool-log-content"><span>{{ input }}</span><span>{{ output }}</span><span>{{ error }}</span></div>',
    },
}));

vi.mock('@components/ModelLogo.vue', () => ({
    default: {
        name: 'ModelLogo',
        props: ['modelId', 'name'],
        template: '<span data-testid="model-logo">{{ name }}</span>',
    },
}));

vi.mock('@components/ModelCapabilityTags.vue', () => ({
    default: {
        name: 'ModelCapabilityTags',
        template: '<span data-testid="capability-tags" />',
    },
}));

vi.mock('@components/SearchableSelect.vue', async () => {
    const { t } = await import('@/i18n');

    return {
        default: {
            name: 'SearchableSelect',
            props: [
                'modelValue',
                'options',
                'disabled',
                'placeholder',
                'placeholderKey',
                'searchPlaceholder',
                'searchPlaceholderKey',
                'emptyText',
                'emptyTextKey',
            ],
            methods: {
                resolveText(key?: string, fallback?: string) {
                    return key ? t(key as never) : (fallback ?? '');
                },
            },
            template:
                '<div data-testid="searchable-select"><span>{{ resolveText(placeholderKey, placeholder) }}</span><span>{{ resolveText(searchPlaceholderKey, searchPlaceholder) }}</span><span>{{ resolveText(emptyTextKey, emptyText) }}</span><slot name="selected" :option="options?.[0] ?? null" /><slot name="option" v-for="option in options" :option="option" /></div>',
        },
    };
});

vi.mock('vue-draggable-plus', () => ({
    VueDraggable: {
        name: 'VueDraggable',
        props: ['modelValue'],
        template: '<div><slot /></div>',
    },
}));

async function flushMountedPromises() {
    for (let index = 0; index < 8; index += 1) {
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
        await nextTick();
    }
}

function createTool(patch: Partial<BuiltInToolEntity> = {}): BuiltInToolEntity {
    return {
        id: 1,
        tool_id: 'bash',
        display_name: 'Bash',
        description: null,
        enabled: 1,
        risk_level: 'high',
        config_json: null,
        last_used_at: null,
        created_at: '2026-05-22T00:00:00.000Z',
        updated_at: '2026-05-22T00:00:00.000Z',
        ...patch,
    };
}

function createLog(patch: Partial<BuiltInToolLogEntity> = {}): BuiltInToolLogEntity {
    return {
        id: 1,
        tool_id: 'bash',
        tool_call_id: 'call_very_long_identifier_without_breaks_abcdefghijklmnopqrstuvwxyz',
        session_id: 123456789,
        message_id: 987654321,
        iteration: 2,
        input: 'E:\\very\\long\\workspace\\path\\without\\natural\\line\\breaks\\command.txt',
        output: 'done',
        status: 'awaiting_approval',
        approval_state: 'pending',
        approval_summary: null,
        duration_ms: 1200,
        error_message: null,
        created_at: '2026-05-22T06:30:00.000Z',
        ...patch,
    };
}

describe('built-in tools settings i18n', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setLocale('zh-CN');
        findBuiltInToolLogsByToolIdMock.mockResolvedValue([]);
        findModelsWithProviderMock.mockResolvedValue([]);
    });

    it('localizes built-in tool descriptions for the active locale', () => {
        setLocale('en-US');

        expect(getBuiltInToolSummary('bash')).toBe('Execute terminal commands');
        expect(getBuiltInToolSummary('read')).toBe(
            'Read local files or folders, including images and PDFs'
        );
        expect(getBuiltInToolSummary('ask_user_question')).toBe(
            'Ask the user structured questions'
        );
        expect(getBuiltInToolSummary('unknown_tool', null)).toBe('No description');
    });

    it('shows the ask-user tool as an empty-config built-in tool', () => {
        expect(isBuiltInToolVisibleInSettings('ask_user_question')).toBe(true);
        expect(usesBuiltInToolEmptyConfig('ask_user_question')).toBe(true);
    });

    it('localizes built-in tool last-used fallback text', () => {
        setLocale('en-US');

        expect(formatToolLastUsed(null)).toBe('Not called yet');
    });

    it('localizes tool log status labels for filter chips and badges', () => {
        setLocale('en-US');

        expect(getToolLogStatusText('success')).toBe('Success');
        expect(getToolLogStatusText('timeout')).toBe('Timed out');
        expect(getToolLogStatusText('awaiting_approval')).toBe('Pending');
        expect(getToolLogStatusText('cancelled')).toBe('Cancelled');
        expect(getToolLogStatusText('pending')).toBe('Pending');
        expect(getBuiltInToolApprovalStateText('pending')).toBe('Pending');
        expect(getBuiltInToolApprovalStateText('approved')).toBe('Approved');
        expect(getBuiltInToolApprovalStateText('rejected')).toBe('Rejected');
        expect(getBuiltInToolApprovalStateText('none')).toBeNull();
    });

    it('renders built-in tool list text and toggle title in English without squeezing long summaries', () => {
        setLocale('en-US');

        const wrapper = mount(BuiltInToolList, {
            props: {
                tools: [createTool()],
                selectedToolId: 'bash',
                togglingToolIds: new Set<number>(),
            },
        });

        expect(wrapper.text()).toContain('Execute terminal commands');
        expect(wrapper.text()).not.toContain('执行终端命令');
        expect(wrapper.get('button').attributes('title')).toBe('Enable/disable');
        expect(wrapper.get('p').classes()).toContain('break-words');
    });

    it('does not let the global DOM localizer rewrite dynamic built-in tool names', () => {
        setLocale('en-US');

        const wrapper = mount(BuiltInToolList, {
            props: {
                tools: [
                    createTool({
                        display_name: '工具',
                    }),
                ],
                selectedToolId: 'bash',
                togglingToolIds: new Set<number>(),
            },
            attachTo: document.body,
        });

        const localizer = createDomLocalizer(document.body);
        localizer.translateNow();

        const title = wrapper.get('h3');
        expect(title.text()).toBe('工具');
        expect(title.attributes('data-no-i18n')).toBe('true');
        expect(title.attributes('translate')).toBe('no');
        expect(wrapper.text()).toContain('Execute terminal commands');

        localizer.stop();
        wrapper.unmount();
    });

    it('renders bash configuration labels, placeholders, titles, and aria labels in English', () => {
        setLocale('en-US');

        const wrapper = mount(BashToolConfig, {
            props: {
                modelValue: {
                    approvalMode: 'high_risk',
                    defaultWorkingDirectory: '',
                    allowedWorkingDirectories: [],
                    timeoutMs: 30000,
                    maxOutputChars: 20000,
                    compactOutput: false,
                },
            },
        });

        expect(wrapper.text()).toContain('Execution and approval');
        expect(wrapper.text()).toContain('Automatic');
        expect(wrapper.text()).toContain('Ask every time');
        expect(wrapper.text()).toContain('Default working directory');
        expect(wrapper.text()).toContain('Allowed working directories');
        expect(wrapper.text()).not.toContain('默认工作目录');
        expect(wrapper.get('input[readonly]').attributes('placeholder')).toBe(
            'Defaults to Desktop at runtime when unset'
        );
        const folderButtons = wrapper.findAll('button[aria-label="Choose folder"]');
        expect(folderButtons.length).toBeGreaterThan(0);
        expect(folderButtons[0]?.attributes('title')).toBe('Choose folder');
    });

    it('renders tool log filters, empty states, localized dates, and breakable detail metadata in English', async () => {
        setLocale('en-US');
        findBuiltInToolLogsByToolIdMock.mockResolvedValue([
            createLog({
                approval_state: 'approved',
            }),
        ]);

        const wrapper = mount(BuiltInToolLogViewer, {
            props: {
                tool: createTool(),
            },
        });
        await flushMountedPromises();

        expect(wrapper.text()).toContain('All');
        expect(wrapper.text()).toContain('Pending');
        expect(wrapper.get('input').attributes('placeholder')).toBe('Search logs...');
        expect(wrapper.text()).toMatch(/May|5\/22\/2026/);
        expect(wrapper.text()).toContain('Iteration 2');
        expect(wrapper.text()).not.toContain('迭代');

        await wrapper.get('button.w-full').trigger('click');

        const detail = wrapper.get('[data-testid="built-in-tool-log-detail-metadata"]');
        expect(detail.classes()).toContain('break-words');
        expect(detail.text()).toContain('Call ID:');
        expect(detail.text()).toContain('Session:');
        expect(detail.text()).toContain('Approval: Approved');
        expect(detail.text()).not.toContain('approved');
    });

    it('does not let the global DOM localizer rewrite dynamic built-in log metadata', async () => {
        setLocale('en-US');
        findBuiltInToolLogsByToolIdMock.mockResolvedValue([
            createLog({
                tool_call_id: '设置',
                approval_state: 'approved',
            }),
        ]);

        const wrapper = mount(BuiltInToolLogViewer, {
            props: {
                tool: createTool({
                    display_name: '工具',
                }),
            },
            attachTo: document.body,
        });
        await flushMountedPromises();

        const localizer = createDomLocalizer(document.body);
        localizer.translateNow();

        const toolTitle = wrapper.get('button.w-full span[data-no-i18n="true"]');
        expect(toolTitle.text()).toBe('工具');

        await wrapper.get('button.w-full').trigger('click');
        await nextTick();
        localizer.translateNow();

        const detail = wrapper.get('[data-testid="built-in-tool-log-detail-metadata"]');
        expect(detail.text()).toContain('Call ID: 设置');
        expect(detail.text()).toContain('Approval: Approved');
        expect(detail.text()).not.toContain('Settings');

        localizer.stop();
        wrapper.unmount();
    });

    it('renders empty tool logs in English after filtering', async () => {
        setLocale('en-US');
        findBuiltInToolLogsByToolIdMock.mockResolvedValue([createLog({ input: 'alpha' })]);

        const wrapper = mount(BuiltInToolLogViewer, {
            props: {
                tool: createTool(),
            },
        });
        await flushMountedPromises();

        await wrapper.get('input').setValue('missing');

        expect(wrapper.text()).toContain('No matching logs');
        expect(wrapper.text()).toContain('Try another search keyword');
        expect(wrapper.text()).not.toContain('未找到匹配的日志');
    });

    it('does not render the default none approval state in log details', async () => {
        setLocale('en-US');
        findBuiltInToolLogsByToolIdMock.mockResolvedValue([
            createLog({
                approval_state: 'none',
            }),
        ]);

        const wrapper = mount(BuiltInToolLogViewer, {
            props: {
                tool: createTool(),
            },
        });
        await flushMountedPromises();

        await wrapper.get('button.w-full').trigger('click');

        const detail = wrapper.get('[data-testid="built-in-tool-log-detail-metadata"]');
        expect(detail.text()).not.toContain('Approval:');
        expect(detail.text()).not.toContain('none');
    });

    it('renders upgrade model configuration text in English and allows long model names to shrink', async () => {
        setLocale('en-US');
        findModelsWithProviderMock.mockResolvedValue([
            {
                id: 1,
                provider_id: 10,
                provider_name: 'Very Long Provider Name',
                provider_driver: 'openai',
                provider_enabled: 1,
                provider_logo: null,
                model_id: 'provider/model-with-a-very-long-id-that-needs-truncation',
                name: 'Model With A Very Long Display Name That Should Not Squeeze The Row',
                attachment: 0,
                modalities: null,
                open_weights: 0,
                reasoning: 1,
                tool_call: 1,
            },
        ]);

        const wrapper = mount(UpgradeModelToolConfig, {
            props: {
                modelValue: {
                    chain: [
                        {
                            providerId: 10,
                            modelId: 'provider/model-with-a-very-long-id-that-needs-truncation',
                        },
                    ],
                },
            },
        });
        await flushMountedPromises();

        expect(wrapper.text()).toContain('Model upgrade chain');
        expect(wrapper.text()).toContain('Provider');
        expect(wrapper.text()).toContain('Search providers');
        expect(wrapper.text()).toContain('No available providers');
        expect(wrapper.text()).toContain('1 available models');
        expect(wrapper.text()).not.toContain('模型升级链');
        expect(wrapper.text()).not.toContain('1 个可选模型');
        expect(wrapper.get('.upgrade-model-chain-card > div').classes()).toContain('min-w-0');
    });

    it('renders status badge text as a non-wrapping English label', () => {
        setLocale('en-US');

        const wrapper = mount(ToolLogStatusBadge, {
            props: {
                status: 'awaiting_approval',
            },
        });

        expect(wrapper.text()).toBe('Pending');
        expect(wrapper.get('span').classes()).toContain('whitespace-nowrap');
    });
});
