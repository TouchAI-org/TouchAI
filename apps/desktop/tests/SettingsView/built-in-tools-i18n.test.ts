import { createToolPart } from '@database/queries/toolParts';
import { createSettingsPanelFixture } from '@tests/utils/settingsPanel';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

let fixture: Awaited<ReturnType<typeof createSettingsPanelFixture>>;
enableAutoUnmount(afterEach);
afterEach(async () => {
    await fixture.dispose();
});

async function flushMountedPromises() {
    await flushPromises();
    await nextTick();
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
        session_id: 1,
        message_id: 1,
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

async function setToolLogs(logs: BuiltInToolLogEntity[]) {
    fixture.database.exec(
        "INSERT INTO sessions (id, session_id, title, model) VALUES (1, 'tool-history', 'Tool history', 'fixture-model'); INSERT INTO messages (id, session_id, role) VALUES (1, 1, 'tool_call')"
    );
    for (const entry of logs) await createToolPart('builtin', { ...entry });
}

describe('given built-in settings use the current owners and active locale', () => {
    beforeEach(async () => {
        document.body.innerHTML = '';
        fixture = await createSettingsPanelFixture();
        setLocale('zh-CN');
    });

    it('user reads built-in descriptions in the active locale', () => {
        setLocale('en-US');

        expect(getBuiltInToolSummary('bash')).toBe('Execute terminal commands');
        expect(getBuiltInToolSummary('read')).toBe(
            'Read local files or folders, including images and PDFs'
        );
        expect(getBuiltInToolSummary('ask_user_question')).toBe(
            'Ask the user structured questions'
        );
        expect(getBuiltInToolSummary('search_conversation')).toBe('Search saved conversations');
        expect(getBuiltInToolSummary('unknown_tool', null)).toBe('No description');
    });

    it('user configures the ask-user tool without an unnecessary configuration form', () => {
        expect(isBuiltInToolVisibleInSettings('ask_user_question')).toBe(true);
        expect(usesBuiltInToolEmptyConfig('ask_user_question')).toBe(true);
        expect(usesBuiltInToolEmptyConfig('search_conversation')).toBe(false);
    });

    it('user given a computer control entry when changing locale then keeps its stable name and localized summary', async () => {
        const wrapper = mount(BuiltInToolList, {
            ...fixture.viewOptions,
            props: {
                tools: [
                    createTool({
                        tool_id: 'computer_use',
                        display_name: 'ComputerUse',
                        description: 'Long native driver instructions',
                    }),
                ],
                selectedToolId: 'computer_use',
            },
        });
        expect(wrapper.get('h3').text()).toBe('ComputerUse');
        expect(wrapper.get('p').text()).toBe('观察屏幕并操作桌面应用');
        setLocale('en-US');
        await nextTick();
        expect(wrapper.get('h3').text()).toBe('ComputerUse');
        expect(wrapper.get('p').text()).toBe('Observe the screen and control desktop apps');
        expect(wrapper.text()).not.toContain('Long native driver instructions');
        wrapper.unmount();
    });

    it('user sees built-in tool last-used fallback text', () => {
        setLocale('en-US');

        expect(formatToolLastUsed(null)).toBe('Not called yet');
    });

    it('user reads log filters and approval badges in the active locale', () => {
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

    it('user reads English tool summaries and toggle titles without squeezing long text', () => {
        setLocale('en-US');

        const wrapper = mount(BuiltInToolList, {
            ...fixture.viewOptions,
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

    it('user keeps dynamic tool names unchanged when the DOM localizer runs', () => {
        setLocale('en-US');

        const wrapper = mount(BuiltInToolList, {
            ...fixture.viewOptions,
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

    it('user configures Bash and reads English labels, placeholders and accessible folder actions', () => {
        setLocale('en-US');

        const wrapper = mount(BashToolConfig, {
            ...fixture.viewOptions,
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

    it('user opens a persisted log and reads its date and content without internal metadata', async () => {
        setLocale('en-US');
        await setToolLogs([
            createLog({
                approval_state: 'approved',
            }),
        ]);

        const wrapper = mount(BuiltInToolLogViewer, {
            ...fixture.viewOptions,
            props: {
                tool: createTool({ description: 'Detailed tool description' }),
            },
        });
        await flushMountedPromises();

        expect(wrapper.text()).toContain('All');
        expect(wrapper.text()).toContain('Pending');
        expect(wrapper.get('input').attributes('placeholder')).toBe('Search logs...');
        const timestamp = wrapper.get('[data-testid="tool-log-header"] time');
        expect(timestamp.text()).toMatch(/May|5\/22\/2026/);
        expect(timestamp.attributes('datetime')).toBe('2026-05-22T06:30:00.000Z');
        expect(wrapper.get('[data-testid="tool-log-header"]').text()).toContain('1.2s');
        expect(wrapper.text()).not.toContain('Iteration');
        expect(wrapper.text()).not.toContain('迭代');

        await wrapper.get('button.w-full').trigger('click');
        await flushMountedPromises();

        expect(wrapper.get('[data-testid="tool-log-content"]').text()).toContain('done');
        expect(wrapper.find('[data-testid="built-in-tool-log-detail-metadata"]').exists()).toBe(
            false
        );
        expect(wrapper.text()).not.toContain('Call ID:');
        expect(wrapper.text()).not.toContain('Session:');
        expect(wrapper.text()).not.toContain('Message:');
        expect(wrapper.text()).not.toContain('Approval:');
        expect(wrapper.text()).not.toContain('call_very_long_identifier');
        expect(wrapper.text()).not.toContain('Detailed tool description');
    });

    it('user expands a persisted log and keeps its dynamic tool name unchanged', async () => {
        setLocale('en-US');
        await setToolLogs([
            createLog({
                tool_call_id: '设置',
                approval_state: 'approved',
            }),
        ]);

        const wrapper = mount(BuiltInToolLogViewer, {
            ...fixture.viewOptions,
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
        await flushMountedPromises();
        localizer.translateNow();

        expect(toolTitle.text()).toBe('工具');
        expect(wrapper.get('[data-testid="tool-log-content"]').text()).toContain('done');
        expect(wrapper.text()).not.toContain('Call ID:');
        expect(wrapper.text()).not.toContain('Approval:');

        localizer.stop();
        wrapper.unmount();
    });

    it('user filters out every persisted log and receives an English empty state', async () => {
        setLocale('en-US');
        await setToolLogs([createLog({ input: 'alpha' })]);

        const wrapper = mount(BuiltInToolLogViewer, {
            ...fixture.viewOptions,
            props: {
                tool: createTool(),
            },
        });
        await flushMountedPromises();

        await wrapper.get('input').setValue('missing');

        expect(wrapper.text()).toContain('No matching logs');
        expect(wrapper.text()).toContain('Try another keyword, or clear the filters.');
        expect(wrapper.text()).toContain('Clear filters');
        expect(wrapper.text()).not.toContain('未找到匹配的日志');
    });

    it('user opens an unapproved log without seeing internal default approval metadata', async () => {
        setLocale('en-US');
        await setToolLogs([
            createLog({
                approval_state: 'none',
            }),
        ]);

        const wrapper = mount(BuiltInToolLogViewer, {
            ...fixture.viewOptions,
            props: {
                tool: createTool(),
            },
        });
        await flushMountedPromises();

        await wrapper.get('button.w-full').trigger('click');

        expect(wrapper.find('[data-testid="built-in-tool-log-detail-metadata"]').exists()).toBe(
            false
        );
        expect(wrapper.text()).not.toContain('Approval:');
        expect(wrapper.text()).not.toContain('none');
    });

    it('user opens an upgrade provider dropdown and reads English labels while long names can shrink', async () => {
        setLocale('en-US');
        fixture.database.exec(`UPDATE providers SET name='Very Long Provider Name' WHERE id=1;
            UPDATE models SET name='Model With A Very Long Display Name That Should Not Squeeze The Row',
            model_id='provider/model-with-a-very-long-id-that-needs-truncation' WHERE id=1;`);

        const wrapper = mount(UpgradeModelToolConfig, {
            ...fixture.viewOptions,
            props: {
                modelValue: {
                    chain: [
                        {
                            providerId: 1,
                            modelId: 'provider/model-with-a-very-long-id-that-needs-truncation',
                        },
                    ],
                },
            },
        });
        await flushMountedPromises();

        expect(wrapper.text()).toContain('Model upgrade chain');
        const provider = wrapper.get('.upgrade-model-chain-card button[aria-expanded]');
        await provider.trigger('click');
        const options = wrapper.findAll('button[aria-selected]');
        expect(document.body.querySelector('input[placeholder="Search providers"]')).not.toBeNull();
        expect(options.map((option) => option.text()).join(' ')).toContain('1 available models');
        expect(wrapper.text()).toContain('Very Long Provider Name');
        expect(wrapper.text()).toContain('Model With A Very Long Display Name');
        await provider.trigger('click');
        await provider.trigger('click');
        const search = document.body.querySelector<HTMLInputElement>(
            'input[placeholder="Search providers"]'
        )!;
        search.value = 'missing-provider';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        await nextTick();
        expect(document.body.textContent).toContain('No available providers');
        expect(wrapper.text()).not.toContain('模型升级链');
        expect(wrapper.text()).not.toContain('1 个可选模型');
        expect(wrapper.get('.upgrade-model-chain-card > div').classes()).toContain('min-w-0');
    });

    it('user reads the pending status as one non-wrapping English label', () => {
        setLocale('en-US');

        const wrapper = mount(ToolLogStatusBadge, {
            ...fixture.viewOptions,
            props: {
                status: 'awaiting_approval',
            },
        });

        expect(wrapper.text()).toBe('Pending');
        expect(wrapper.get('span').classes()).toContain('whitespace-nowrap');
    });
});
