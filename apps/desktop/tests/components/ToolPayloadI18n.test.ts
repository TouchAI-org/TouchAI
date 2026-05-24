import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import type { ToolApprovalInfo, ToolCallInfo } from '@/types/session';
import ToolApprovalCard from '@/views/SearchView/components/ConversationPanel/components/ToolApprovalCard.vue';
import ToolCallItem from '@/views/SearchView/components/ConversationPanel/components/ToolCallItem.vue';

vi.mock('@components/AppIcon.vue', () => ({
    default: {
        name: 'AppIcon',
        template: '<span data-testid="app-icon" />',
    },
}));

vi.mock('@/services/BuiltInToolService/tools/bash/helper', () => ({
    isEmptyBashOutputText: (output?: string | null) => {
        const normalizedOutput = output?.trim();
        return (
            !normalizedOutput ||
            ['[命令无输出]', '[No command output]', 'No output', '[No output]'].includes(
                normalizedOutput
            )
        );
    },
    parseBashToolResult: (result?: string) => {
        const raw = result?.trim();
        if (!raw) {
            return {
                shell: null,
                duration: null,
                output: null,
            };
        }

        const normalized = raw.replace(/\r\n/g, '\n');
        const splitIndex = normalized.indexOf('\n\n');
        if (splitIndex < 0) {
            return {
                shell: null,
                duration: null,
                output: normalized,
            };
        }

        const headerText = normalized.slice(0, splitIndex);
        const output = normalized.slice(splitIndex + 2).trim();
        const shellMatch = /^Shell: (.+)$/m.exec(headerText);
        const durationMatch = /^Duration: (.+)$/m.exec(headerText);
        return {
            shell: shellMatch?.[1]?.trim() || null,
            duration: durationMatch?.[1]?.trim() || null,
            output,
        };
    },
}));

function expectNoI18n(attributes: Record<string, string | undefined>) {
    expect(attributes['data-no-i18n']).toBe('true');
    expect(attributes.translate).toBe('no');
}

function expectAllowsI18n(attributes: Record<string, string | undefined>) {
    expect(attributes['data-no-i18n']).toBeUndefined();
    expect(attributes.translate).toBeUndefined();
}

function createApproval(overrides: Partial<ToolApprovalInfo> = {}): ToolApprovalInfo {
    return {
        id: 'approval-1',
        callId: 'call-1',
        status: 'pending',
        title: 'Run command',
        description: '',
        command: 'Remove-Item E:\\tmp\\settings.json',
        riskLabel: 'High',
        reason: '',
        commandLabel: 'Command',
        approveLabel: 'Approve',
        rejectLabel: 'Reject',
        enterHint: 'Enter',
        escHint: 'Esc',
        keyboardApproveAt: Date.now(),
        ...overrides,
    };
}

function createToolCall(overrides: Partial<ToolCallInfo> = {}): ToolCallInfo {
    return {
        id: 'tool-call-1',
        name: 'read',
        namespacedName: 'builtin__read',
        source: 'builtin',
        arguments: {},
        status: 'completed',
        ...overrides,
    };
}

describe('tool payload i18n boundaries', () => {
    beforeEach(() => {
        setLocale('zh-CN');
    });

    it('translates app-owned ToolApprovalCard text at render time after a locale switch', async () => {
        setLocale('en-US');
        const wrapper = mount(ToolApprovalCard, {
            props: {
                approval: createApproval({
                    title: '命令执行需要确认',
                    description: '这是一个高风险命令，请确认后再继续执行。',
                    reason: '命令可能修改文件或系统状态。',
                    approveLabel: '批准执行',
                    rejectLabel: '拒绝执行',
                    enterHint: 'Enter 批准',
                    escHint: 'Esc 拒绝',
                }),
            },
        });

        expect(wrapper.get('.tool-approval-card__title').text()).toBe(
            'Command execution needs confirmation'
        );
        expect(wrapper.get('.tool-approval-card__description').text()).toBe(
            'This is a high-risk command. Confirm before continuing.'
        );
        expect(wrapper.get('.tool-approval-card__button--approve').text()).toContain(
            'Approve execution'
        );
        expect(wrapper.get('.tool-approval-card__button--reject').text()).toContain(
            'Reject execution'
        );
        expectAllowsI18n(wrapper.get('.tool-approval-card__title').attributes());
        expectAllowsI18n(wrapper.get('.tool-approval-card__description').attributes());
        expectNoI18n(wrapper.get('.tool-approval-card__command').attributes());
        expectAllowsI18n(wrapper.get('.tool-approval-card__button--approve').attributes());

        setLocale('zh-CN');
        await wrapper.vm.$nextTick();

        expect(wrapper.get('.tool-approval-card__title').text()).toBe('命令执行需要确认');
        expect(wrapper.get('.tool-approval-card__description').text()).toBe(
            '这是一个高风险命令，请确认后再继续执行。'
        );
        expect(wrapper.get('.tool-approval-card__button--approve').text()).toContain('批准执行');
    });

    it('translates dynamic model-switch approval descriptions without treating them as payload', async () => {
        setLocale('en-US');
        const wrapper = mount(ToolApprovalCard, {
            props: {
                approval: createApproval({
                    title: '模型切换确认',
                    description: '允许从 Provider A / Model A 切换到 Provider B / Model B',
                }),
            },
        });

        const description = wrapper.get('.tool-approval-card__description');
        expect(description.text()).toBe(
            'Allow switching from Provider A / Model A to Provider B / Model B'
        );
        expectAllowsI18n(description.attributes());

        setLocale('zh-CN');
        await wrapper.vm.$nextTick();

        expect(description.text()).toBe('允许从 Provider A / Model A 切换到 Provider B / Model B');
    });

    it('translates canonical app-owned approval titles without treating them as payload', () => {
        setLocale('en-US');

        const cases = [
            ['命令执行确认', 'Confirm command execution'],
            ['读取本地内容确认', 'Confirm local content read'],
            ['模型切换确认', 'Confirm model switch'],
            ['设置修改确认', 'Confirm setting change'],
        ] as const;

        for (const [title, expectedTitle] of cases) {
            const wrapper = mount(ToolApprovalCard, {
                props: {
                    approval: createApproval({
                        title,
                        description: '',
                    }),
                },
            });

            const titleElement = wrapper.get('.tool-approval-card__title');
            expect(titleElement.text()).toBe(expectedTitle);
            expectAllowsI18n(titleElement.attributes());
        }
    });

    it('translates canonical app-owned approval reasons without treating them as payload', () => {
        setLocale('en-US');

        const cases = [
            [
                '当前配置要求所有 Bash 命令都必须先批准。',
                'Current configuration requires approval before every Bash command.',
            ],
            ['命令可能删除文件或目录。', 'The command may delete files or directories.'],
            ['命令可能重置或清理 Git 工作区。', 'The command may reset or clean the Git worktree.'],
            ['命令可能修改或覆盖文件内容。', 'The command may modify or overwrite file contents.'],
            [
                '命令包含输出重定向，可能覆写文件。',
                'The command contains output redirection and may overwrite files.',
            ],
            [
                '命令可能修改系统配置或影响设备状态。',
                'The command may modify system configuration or affect device state.',
            ],
            [
                '此操作会读取本地文件或目录内容，并将结果发送给模型。',
                'This operation reads local file or directory contents and sends the result to the model.',
            ],
            [
                '这会修改当前问答后续使用的模型，并同步影响后续默认模型。',
                'This changes the model used by the current conversation and also affects the subsequent default model.',
            ],
            [
                '此操作会修改 TouchAI 的应用设置，并立即影响后续行为。',
                'This operation changes TouchAI application settings and affects future behavior immediately.',
            ],
        ] as const;

        for (const [reason, expectedReason] of cases) {
            const wrapper = mount(ToolApprovalCard, {
                props: {
                    approval: createApproval({
                        title: '命令执行确认',
                        description: '',
                        reason,
                    }),
                },
            });

            const description = wrapper.get('.tool-approval-card__description');
            expect(description.text()).toBe(expectedReason);
            expectAllowsI18n(description.attributes());
        }
    });

    it('marks ToolApprovalCard custom title and description payload as not eligible for global DOM localization', () => {
        const wrapper = mount(ToolApprovalCard, {
            props: {
                approval: createApproval({
                    title: 'Shell permission request',
                    description: 'Delete the user settings database',
                }),
            },
        });

        expectNoI18n(wrapper.get('.tool-approval-card__title').attributes());
        expectNoI18n(wrapper.get('.tool-approval-card__description').attributes());
        expectNoI18n(wrapper.get('.tool-approval-card__command').attributes());
        expectAllowsI18n(wrapper.get('.tool-approval-card__button--approve').attributes());
    });

    it('marks ToolApprovalCard reason payload as not eligible for global DOM localization', () => {
        const wrapper = mount(ToolApprovalCard, {
            props: {
                approval: createApproval({
                    description: '  ',
                    reason: 'The shell command can modify files outside the project',
                }),
            },
        });

        const description = wrapper.get('.tool-approval-card__description');
        expect(description.text()).toBe('The shell command can modify files outside the project');
        expectNoI18n(description.attributes());
    });

    it('marks ToolApprovalCard resolution payload but not fallback resolution text as no-i18n', () => {
        const customResolution = mount(ToolApprovalCard, {
            props: {
                approval: createApproval({
                    status: 'rejected',
                    resolutionText: 'Rejected by policy: network access denied',
                }),
            },
        });

        expectNoI18n(customResolution.get('.tool-approval-card__resolution-text').attributes());
        expectAllowsI18n(
            customResolution.get('.tool-approval-card__resolution-badge').attributes()
        );

        const fallbackResolution = mount(ToolApprovalCard, {
            props: {
                approval: createApproval({
                    status: 'rejected',
                }),
            },
        });

        expectAllowsI18n(
            fallbackResolution.get('.tool-approval-card__resolution-text').attributes()
        );
    });

    it('translates app-owned approval resolution text but preserves custom resolution payload', () => {
        setLocale('en-US');

        const appOwnedResolution = mount(ToolApprovalCard, {
            props: {
                approval: createApproval({
                    status: 'rejected',
                    resolutionText: '已拒绝执行此命令',
                }),
            },
        });

        expect(appOwnedResolution.get('.tool-approval-card__resolution-text').text()).toBe(
            'Rejected this command'
        );
        expectAllowsI18n(
            appOwnedResolution.get('.tool-approval-card__resolution-text').attributes()
        );

        const requestCancelledResolution = mount(ToolApprovalCard, {
            props: {
                approval: createApproval({
                    status: 'cancelled',
                    resolutionText: '请求已取消',
                }),
            },
        });

        expect(requestCancelledResolution.get('.tool-approval-card__resolution-text').text()).toBe(
            'Request cancelled'
        );
        expectAllowsI18n(
            requestCancelledResolution.get('.tool-approval-card__resolution-text').attributes()
        );

        const customResolution = mount(ToolApprovalCard, {
            props: {
                approval: createApproval({
                    status: 'rejected',
                    resolutionText: 'Rejected by policy: network access denied',
                }),
            },
        });

        expect(customResolution.get('.tool-approval-card__resolution-text').text()).toBe(
            'Rejected by policy: network access denied'
        );
        expectNoI18n(customResolution.get('.tool-approval-card__resolution-text').attributes());
    });

    it('renders ToolApprovalCard fallback resolution text in English', () => {
        setLocale('en-US');

        const rejected = mount(ToolApprovalCard, {
            props: {
                approval: createApproval({
                    status: 'rejected',
                    title: '',
                    resolutionText: '',
                }),
            },
        });

        expect(rejected.get('.tool-approval-card__title').text()).toBe('Confirmation required');
        expect(rejected.get('.tool-approval-card__resolution-badge').text()).toBe('Rejected');
        expect(rejected.get('.tool-approval-card__resolution-text').text()).toBe(
            'This command was not executed'
        );

        const cancelled = mount(ToolApprovalCard, {
            props: {
                approval: createApproval({
                    status: 'cancelled',
                    title: '',
                    resolutionText: '',
                }),
            },
        });

        expect(cancelled.get('.tool-approval-card__resolution-badge').text()).toBe('Cancelled');
        expect(cancelled.get('.tool-approval-card__resolution-text').text()).toBe(
            'This command was cancelled'
        );
    });

    it('marks ToolCallItem folded built-in summary payload without opting out static verb text', () => {
        const wrapper = mount(ToolCallItem, {
            props: {
                toolCall: createToolCall({
                    builtinPresentation: {
                        verb: '已读取',
                        content: 'E:\\Project\\TouchAI\\设置.txt',
                    },
                    durationMs: 1250,
                }),
            },
        });

        expectAllowsI18n(wrapper.get('.tool-call-log-verb').attributes());
        expectNoI18n(wrapper.get('.tool-call-log-content').attributes());
        expectNoI18n(wrapper.get('.tool-call-log-duration').attributes());
    });

    it('marks ToolCallItem folded tool and server payload without opting out static status text', () => {
        const wrapper = mount(ToolCallItem, {
            props: {
                toolCall: createToolCall({
                    name: 'query_database',
                    namespacedName: 'analytics__query_database',
                    source: 'mcp',
                    serverName: 'Analytics MCP',
                }),
            },
        });

        expectNoI18n(wrapper.get('.tool-call-label').attributes());
        expectNoI18n(wrapper.get('.tool-call-server').attributes());
        expectAllowsI18n(wrapper.get('.tool-call-status').attributes());
    });

    it('marks BuiltInBashToolCallItem folded summary payload without opting out static verb text', () => {
        const wrapper = mount(ToolCallItem, {
            props: {
                toolCall: createToolCall({
                    name: 'bash',
                    namespacedName: 'builtin__bash',
                    builtinPresentation: {
                        verb: '已运行',
                        content: 'pnpm test --filter 设置',
                    },
                    durationMs: 2080,
                }),
            },
        });

        expectAllowsI18n(wrapper.get('.tool-call-log-verb').attributes());
        expectNoI18n(wrapper.get('.tool-call-log-content').attributes());
        expectNoI18n(wrapper.get('.tool-call-log-duration').attributes());
    });

    it('renders non-payload tool call status and fallback result text in English', async () => {
        setLocale('en-US');

        const wrapper = mount(ToolCallItem, {
            props: {
                toolCall: createToolCall({
                    name: 'query_database',
                    namespacedName: 'analytics__query_database',
                    source: 'mcp',
                    status: 'awaiting_approval',
                }),
            },
        });

        expect(wrapper.get('.tool-call-status').text()).toBe('Pending');

        await wrapper.get('.tool-call-toggle').trigger('click');

        expect(wrapper.text()).toContain('Arguments');
        expect(wrapper.text()).toContain('Result');
        const resultBlock = wrapper.findAll('.tool-call-block')[1];
        expect(resultBlock?.text()).toContain('Waiting for user approval before continuing...');
    });

    it('renders every non-payload tool call status and empty result fallback in English', async () => {
        setLocale('en-US');

        const cases = [
            ['executing', 'Running', 'Running...'],
            ['error', 'Failed', 'No error output'],
            ['rejected', 'Rejected', 'The user rejected this execution'],
            ['cancelled', 'Cancelled', 'Request cancelled'],
            ['completed', 'Done', 'No output'],
        ] as const;

        for (const [status, expectedStatus, expectedResult] of cases) {
            const wrapper = mount(ToolCallItem, {
                props: {
                    toolCall: createToolCall({
                        name: 'query_database',
                        namespacedName: 'analytics__query_database',
                        source: 'mcp',
                        status,
                    }),
                },
            });

            expect(wrapper.get('.tool-call-status').text()).toBe(expectedStatus);

            await wrapper.get('.tool-call-toggle').trigger('click');

            const resultBlock = wrapper.findAll('.tool-call-block')[1];
            expect(resultBlock?.text()).toBe(expectedResult);
            expect(/[\u3400-\u9fff]/u.test(wrapper.text())).toBe(false);
        }
    });

    it('renders Bash fallback output and status text in English', async () => {
        setLocale('en-US');

        const cases = [
            '[命令无输出]',
            '[No command output]',
            'No output',
            '[No output]',
            [
                'Shell: powershell',
                'Working directory: E:\\codex-worktrees\\TouchAI',
                'Exit code: 0',
                'Duration: 32ms',
                '',
                '[No command output]',
            ].join('\n'),
        ];

        for (const result of cases) {
            const wrapper = mount(ToolCallItem, {
                props: {
                    toolCall: createToolCall({
                        name: 'bash',
                        namespacedName: 'builtin__bash',
                        arguments: {
                            command: 'Write-Output hello',
                        },
                        status: 'completed',
                        result,
                    }),
                },
            });

            await wrapper.get('.tool-call-log-button').trigger('click');

            expect(wrapper.get('.tool-call-bash-status-text').text()).toBe('Success');
            expect(wrapper.get('.tool-call-bash-output').text()).toBe('No output');
            expect(wrapper.get('.tool-call-bash-output').attributes('data-no-i18n')).toBeUndefined();
            expect(wrapper.get('.tool-call-bash-output').attributes('translate')).toBeUndefined();
        }
    });

    it('preserves real Bash output payload even when it contains surrounding metadata', async () => {
        setLocale('en-US');

        const wrapper = mount(ToolCallItem, {
            props: {
                toolCall: createToolCall({
                    name: 'bash',
                    namespacedName: 'builtin__bash',
                    arguments: {
                        command: 'Write-Output hello',
                    },
                    status: 'completed',
                    result: [
                        'Shell: powershell',
                        'Working directory: E:\\codex-worktrees\\TouchAI',
                        'Exit code: 0',
                        'Duration: 32ms',
                        '',
                        'hello',
                    ].join('\n'),
                }),
            },
        });

        await wrapper.get('.tool-call-log-button').trigger('click');

        expect(wrapper.get('.tool-call-bash-status-text').text()).toBe('Success');
        expect(wrapper.get('.tool-call-bash-output').text()).toBe('hello');
        expectNoI18n(wrapper.get('.tool-call-bash-output').attributes());
    });

    it('renders every Bash runtime status and empty output fallback in English', async () => {
        setLocale('en-US');

        const cases = [
            [
                'awaiting_approval',
                'Pending',
                'Waiting for user approval before continuing...',
            ],
            ['executing', 'Running', 'Command running...'],
            ['error', 'Failed', 'No error output'],
            ['rejected', 'Rejected', 'The user rejected this execution'],
            ['cancelled', 'Cancelled', 'Command cancelled'],
            ['completed', 'Success', 'No output'],
        ] as const;

        for (const [status, expectedStatus, expectedOutput] of cases) {
            const wrapper = mount(ToolCallItem, {
                props: {
                    toolCall: createToolCall({
                        name: 'bash',
                        namespacedName: 'builtin__bash',
                        arguments: {
                            command: 'Write-Output hello',
                        },
                        status,
                        result: '',
                    }),
                },
            });

            await wrapper.get('.tool-call-log-button').trigger('click');

            expect(wrapper.get('.tool-call-bash-status-text').text()).toBe(expectedStatus);
            expect(wrapper.get('.tool-call-bash-output').text()).toBe(expectedOutput);
            expect(/[\u3400-\u9fff]/u.test(wrapper.text())).toBe(false);
        }
    });
});
