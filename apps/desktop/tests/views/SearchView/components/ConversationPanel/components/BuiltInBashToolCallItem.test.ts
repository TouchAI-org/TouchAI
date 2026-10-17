import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

import type { ToolCallInfo } from '@/types/session';
import BuiltInBashToolCallItem from '@/views/SearchView/components/ConversationPanel/components/BuiltInBashToolCallItem.vue';

function createBashResult(output: string, duration = '500ms') {
    return [
        'Shell: powershell',
        'Working directory: D:\\Project\\TouchAI',
        'Exit code: none',
        `Duration: ${duration}`,
        '',
        output,
    ].join('\n');
}

function createToolCall(overrides: Partial<ToolCallInfo> = {}): ToolCallInfo {
    return {
        id: 'call-bash-1',
        name: 'Bash',
        namespacedName: 'builtin__bash',
        source: 'builtin',
        sourceLabel: '内置工具',
        arguments: {
            command: 'Write-Output "stream-1"',
        },
        status: 'completed',
        result: createBashResult('done', '900ms'),
        ...overrides,
    };
}

describe('BuiltInBashToolCallItem', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('auto-expands and shows live output while the bash tool is executing', async () => {
        const wrapper = mount(BuiltInBashToolCallItem, {
            props: {
                toolCall: createToolCall({
                    status: 'executing',
                    result: createBashResult('stream-1'),
                }),
                verbText: '正在执行',
                summaryText: 'Write-Output "stream-1"',
                durationText: null,
            },
        });

        await nextTick();

        expect(wrapper.find('.tool-call-log-button').attributes('aria-expanded')).toBe('true');
        expect(wrapper.find('.tool-call-bash-output').text()).toContain('stream-1');
    });

    it('updates the displayed duration every second while the bash tool is running', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-29T00:00:00.000Z'));

        const wrapper = mount(BuiltInBashToolCallItem, {
            props: {
                toolCall: createToolCall({
                    status: 'executing',
                    startedAt: Date.now(),
                    result: createBashResult('stream-1'),
                }),
                verbText: '正在执行',
                summaryText: 'Write-Output "stream-1"',
                durationText: null,
            },
        });

        await nextTick();
        expect(wrapper.find('.tool-call-log-duration').text()).toContain('0s');

        await vi.advanceTimersByTimeAsync(3_100);
        await nextTick();

        expect(wrapper.find('.tool-call-log-duration').text()).toContain('3s');
        expect(wrapper.find('.tool-call-bash-panel-header-duration').text()).toBe('3s');
    });

    it('auto-expands and keeps a live timer while awaiting approval', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-29T00:00:00.000Z'));

        const wrapper = mount(BuiltInBashToolCallItem, {
            props: {
                toolCall: createToolCall({
                    status: 'awaiting_approval',
                    startedAt: Date.now(),
                    result: createBashResult(''),
                }),
                verbText: '等待批准',
                summaryText: 'Write-Output "stream-1"',
                durationText: null,
            },
        });

        await nextTick();
        expect(wrapper.find('.tool-call-log-button').attributes('aria-expanded')).toBe('true');
        expect(wrapper.find('.tool-call-bash-output').text()).toContain('等待用户批准后继续执行');
        expect(wrapper.find('.tool-call-log-duration').text()).toContain('0s');

        await vi.advanceTimersByTimeAsync(2_100);
        await nextTick();

        expect(wrapper.find('.tool-call-log-duration').text()).toContain('2s');
    });

    it('formats settled durations with day precision', async () => {
        const durationMs = (((10 * 24 + 20) * 60 + 30) * 60 + 20) * 1000;
        const wrapper = mount(BuiltInBashToolCallItem, {
            props: {
                toolCall: createToolCall({
                    status: 'completed',
                    durationMs,
                    result: createBashResult('done', `${durationMs}ms`),
                }),
                verbText: '已执行',
                summaryText: 'Write-Output "done"',
                durationText: null,
            },
        });

        await nextTick();

        expect(wrapper.find('.tool-call-log-duration').text()).toContain('10d 20h 30m 20s');
        await wrapper.find('.tool-call-log-button').trigger('click');
        await nextTick();
        expect(wrapper.find('.tool-call-bash-panel-header-duration').text()).toBe(
            '10d 20h 30m 20s'
        );
    });

    it('auto-collapses after execution finishes when the user has not overridden the state', async () => {
        const wrapper = mount(BuiltInBashToolCallItem, {
            props: {
                toolCall: createToolCall({
                    status: 'executing',
                    result: createBashResult('stream-1'),
                }),
                verbText: '正在执行',
                summaryText: 'Write-Output "stream-1"',
                durationText: null,
            },
        });

        await nextTick();
        expect(wrapper.find('.tool-call-log-button').attributes('aria-expanded')).toBe('true');

        await wrapper.setProps({
            toolCall: createToolCall({
                status: 'completed',
                result: createBashResult('stream-1\nstream-2', '1000ms'),
            }),
        });
        await nextTick();

        expect(wrapper.find('.tool-call-log-button').attributes('aria-expanded')).toBe('false');
    });

    it('auto-collapses after execution fails when the user has not overridden the state', async () => {
        const wrapper = mount(BuiltInBashToolCallItem, {
            props: {
                toolCall: createToolCall({
                    status: 'executing',
                    result: createBashResult('stream-1'),
                }),
                verbText: '正在执行',
                summaryText: 'Write-Output "stream-1"',
                durationText: null,
            },
        });

        await nextTick();
        expect(wrapper.find('.tool-call-log-button').attributes('aria-expanded')).toBe('true');

        await wrapper.setProps({
            toolCall: createToolCall({
                status: 'error',
                result: createBashResult('stream-1\nboom', '1000ms'),
            }),
        });
        await nextTick();

        expect(wrapper.find('.tool-call-log-button').attributes('aria-expanded')).toBe('false');
    });

    it('auto-collapses after execution is cancelled when the user has not overridden the state', async () => {
        const wrapper = mount(BuiltInBashToolCallItem, {
            props: {
                toolCall: createToolCall({
                    status: 'executing',
                    result: createBashResult('stream-1'),
                }),
                verbText: '正在执行',
                summaryText: 'Write-Output "stream-1"',
                durationText: null,
            },
        });

        await nextTick();
        expect(wrapper.find('.tool-call-log-button').attributes('aria-expanded')).toBe('true');

        await wrapper.setProps({
            toolCall: createToolCall({
                status: 'cancelled',
                result: createBashResult('stream-1', '1000ms'),
            }),
        });
        await nextTick();

        expect(wrapper.find('.tool-call-log-button').attributes('aria-expanded')).toBe('false');
    });

    it('auto-collapses after execution is rejected when the user has not overridden the state', async () => {
        const wrapper = mount(BuiltInBashToolCallItem, {
            props: {
                toolCall: createToolCall({
                    status: 'awaiting_approval',
                    result: createBashResult('stream-1'),
                }),
                verbText: '等待批准',
                summaryText: 'Write-Output "stream-1"',
                durationText: null,
            },
        });

        await nextTick();
        expect(wrapper.find('.tool-call-log-button').attributes('aria-expanded')).toBe('true');

        await wrapper.setProps({
            toolCall: createToolCall({
                status: 'rejected',
                result: createBashResult('stream-1', '1000ms'),
            }),
        });
        await nextTick();

        expect(wrapper.find('.tool-call-log-button').attributes('aria-expanded')).toBe('false');
    });

    it('keeps the manual expanded state after execution finishes', async () => {
        const wrapper = mount(BuiltInBashToolCallItem, {
            props: {
                toolCall: createToolCall({
                    status: 'executing',
                    result: createBashResult('stream-1'),
                }),
                verbText: '正在执行',
                summaryText: 'Write-Output "stream-1"',
                durationText: null,
            },
        });

        await nextTick();
        expect(wrapper.find('.tool-call-log-button').attributes('aria-expanded')).toBe('true');

        await wrapper.find('.tool-call-log-button').trigger('click');
        await nextTick();
        expect(wrapper.find('.tool-call-log-button').attributes('aria-expanded')).toBe('false');

        await wrapper.find('.tool-call-log-button').trigger('click');
        await nextTick();
        expect(wrapper.find('.tool-call-log-button').attributes('aria-expanded')).toBe('true');

        await wrapper.setProps({
            toolCall: createToolCall({
                status: 'completed',
                result: createBashResult('stream-1\nstream-2', '1000ms'),
            }),
        });
        await nextTick();

        expect(wrapper.find('.tool-call-log-button').attributes('aria-expanded')).toBe('true');
    });

    it('keeps the manual collapsed state when execution status changes again', async () => {
        const wrapper = mount(BuiltInBashToolCallItem, {
            props: {
                toolCall: createToolCall({
                    status: 'executing',
                    result: createBashResult('stream-1'),
                }),
                verbText: '正在执行',
                summaryText: 'Write-Output "stream-1"',
                durationText: null,
            },
        });

        await nextTick();
        expect(wrapper.find('.tool-call-log-button').attributes('aria-expanded')).toBe('true');

        await wrapper.find('.tool-call-log-button').trigger('click');
        await nextTick();
        expect(wrapper.find('.tool-call-log-button').attributes('aria-expanded')).toBe('false');

        await wrapper.setProps({
            toolCall: createToolCall({
                status: 'completed',
                result: createBashResult('stream-1\nstream-2', '1000ms'),
            }),
        });
        await nextTick();

        await wrapper.setProps({
            toolCall: createToolCall({
                status: 'executing',
                result: createBashResult('stream-3', '1200ms'),
            }),
        });
        await nextTick();

        expect(wrapper.find('.tool-call-log-button').attributes('aria-expanded')).toBe('false');
    });

    it('follows growing output to the bottom while the user has not scrolled up', async () => {
        const wrapper = mount(BuiltInBashToolCallItem, {
            props: {
                toolCall: createToolCall({
                    status: 'executing',
                    result: createBashResult('stream-1'),
                }),
                verbText: '正在执行',
                summaryText: 'Write-Output "stream-1"',
                durationText: null,
            },
        });

        await nextTick();

        const output = wrapper.find('.tool-call-bash-output').element as HTMLElement;
        let scrollTop = 0;
        Object.defineProperties(output, {
            clientHeight: { configurable: true, value: 160 },
            scrollHeight: { configurable: true, value: 640 },
            scrollTop: {
                configurable: true,
                get: () => scrollTop,
                set: (value: number) => {
                    scrollTop = value;
                },
            },
        });

        await wrapper.setProps({
            toolCall: createToolCall({
                status: 'executing',
                result: createBashResult('stream-1\nstream-2'),
            }),
        });
        await nextTick();

        expect(scrollTop).toBe(480);
    });

    it('stops following growing output after the user scrolls up', async () => {
        const wrapper = mount(BuiltInBashToolCallItem, {
            props: {
                toolCall: createToolCall({
                    status: 'executing',
                    result: createBashResult('stream-1'),
                }),
                verbText: '正在执行',
                summaryText: 'Write-Output "stream-1"',
                durationText: null,
            },
        });

        await nextTick();

        const output = wrapper.find('.tool-call-bash-output').element as HTMLElement;
        let scrollTop = 0;
        let scrollHeight = 640;
        Object.defineProperties(output, {
            clientHeight: { configurable: true, value: 160 },
            scrollHeight: {
                configurable: true,
                get: () => scrollHeight,
            },
            scrollTop: {
                configurable: true,
                get: () => scrollTop,
                set: (value: number) => {
                    scrollTop = value;
                },
            },
        });

        await wrapper.setProps({
            toolCall: createToolCall({
                status: 'executing',
                result: createBashResult('stream-1\nstream-2'),
            }),
        });
        await nextTick();
        expect(scrollTop).toBe(480);

        scrollTop = 120;
        await wrapper.find('.tool-call-bash-output').trigger('scroll');

        scrollHeight = 800;
        await wrapper.setProps({
            toolCall: createToolCall({
                status: 'executing',
                result: createBashResult('stream-1\nstream-2\nstream-3'),
            }),
        });
        await nextTick();

        expect(scrollTop).toBe(120);
    });

    it('resumes following output when the user scrolls back to the bottom', async () => {
        const wrapper = mount(BuiltInBashToolCallItem, {
            props: {
                toolCall: createToolCall({
                    status: 'executing',
                    result: createBashResult('stream-1'),
                }),
                verbText: '正在执行',
                summaryText: 'Write-Output "stream-1"',
                durationText: null,
            },
        });

        await nextTick();

        const output = wrapper.find('.tool-call-bash-output').element as HTMLElement;
        let scrollTop = 0;
        let scrollHeight = 640;
        Object.defineProperties(output, {
            clientHeight: { configurable: true, value: 160 },
            scrollHeight: {
                configurable: true,
                get: () => scrollHeight,
            },
            scrollTop: {
                configurable: true,
                get: () => scrollTop,
                set: (value: number) => {
                    scrollTop = value;
                },
            },
        });

        await wrapper.setProps({
            toolCall: createToolCall({
                status: 'executing',
                result: createBashResult('stream-1\nstream-2'),
            }),
        });
        await nextTick();
        expect(scrollTop).toBe(480);

        scrollTop = 120;
        await wrapper.find('.tool-call-bash-output').trigger('scroll');

        scrollTop = 480;
        await wrapper.find('.tool-call-bash-output').trigger('scroll');

        scrollHeight = 800;
        await wrapper.setProps({
            toolCall: createToolCall({
                status: 'executing',
                result: createBashResult('stream-1\nstream-2\nstream-3'),
            }),
        });
        await nextTick();

        expect(scrollTop).toBe(640);
    });
});
