import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import type { ToolCallInfo } from '@/types/session';
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
            expect(
                wrapper.get('.tool-call-bash-output').attributes('data-no-i18n')
            ).toBeUndefined();
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
            ['awaiting_approval', 'Pending', 'Waiting for user approval before continuing...'],
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
