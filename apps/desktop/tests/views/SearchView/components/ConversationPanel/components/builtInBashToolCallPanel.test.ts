import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

import type { ToolCallInfo } from '@/types/session';
import BuiltInBashToolCallItem from '@/views/SearchView/components/ConversationPanel/components/BuiltInBashToolCallItem.vue';

/*
 * The existing BuiltInBashToolCallItem test covers expansion, the live timer and
 * scroll following. What is left is what the user reads inside the panel: the
 * status word for each outcome, the fallback text when there is no output, the
 * compressed marker, and the colouring of the command itself.
 */

function createBashResult(
    output: string,
    { duration = '500ms', compressed = false, shell = 'powershell' } = {}
) {
    const lines = [
        `Shell: ${shell}`,
        'Working directory: D:\\Project\\TouchAI',
        'Exit code: none',
        `Duration: ${duration}`,
    ];
    if (compressed) lines.push('Compressed: true');
    lines.push('', output);
    return lines.join('\n');
}

function createToolCall(overrides: Partial<ToolCallInfo> = {}): ToolCallInfo {
    return {
        id: 'call-bash-1',
        name: 'Bash',
        namespacedName: 'builtin__bash',
        source: 'builtin',
        sourceLabel: '内置工具',
        arguments: { command: 'Write-Output "stream-1"' },
        status: 'completed',
        result: createBashResult('done'),
        ...overrides,
    };
}

function mountItem(toolCall: Partial<ToolCallInfo> = {}, props: Record<string, unknown> = {}) {
    return mount(BuiltInBashToolCallItem, {
        props: {
            toolCall: createToolCall(toolCall),
            verbText: '已执行',
            summaryText: 'Write-Output "stream-1"',
            durationText: null,
            ...props,
        },
    });
}

function statusText(wrapper: ReturnType<typeof mountItem>) {
    return wrapper.get('.tool-call-bash-status-text').text();
}

function output(wrapper: ReturnType<typeof mountItem>) {
    return wrapper.get('.tool-call-bash-output');
}

async function expandPanel(wrapper: ReturnType<typeof mountItem>) {
    await wrapper.get('.tool-call-log-button').trigger('click');
    await nextTick();
}

afterEach(() => {
    vi.useRealTimers();
});

describe('user reads the status of a bash command', () => {
    it('user sees a finished command called successful', async () => {
        const wrapper = mountItem({ status: 'completed' });
        await nextTick();
        await expandPanel(wrapper);

        expect(statusText(wrapper)).toBe('成功');
    });

    it('user sees a running command called running', async () => {
        const wrapper = mountItem({ status: 'executing' });
        await nextTick();

        expect(statusText(wrapper)).toBe('运行中');
    });

    it('user sees a failed command called failed', async () => {
        const wrapper = mountItem({ status: 'error' });
        await nextTick();
        await expandPanel(wrapper);

        expect(statusText(wrapper)).toBe('失败');
    });

    it('user sees a cancelled command called cancelled', async () => {
        const wrapper = mountItem({ status: 'cancelled' });
        await nextTick();
        await expandPanel(wrapper);

        expect(statusText(wrapper)).toBe('已取消');
    });

    it('user sees a rejected command called rejected', async () => {
        const wrapper = mountItem({ status: 'rejected' });
        await nextTick();
        await expandPanel(wrapper);

        expect(statusText(wrapper)).toBe('已拒绝');
    });

    it('user sees a command waiting on them called out as such', async () => {
        const wrapper = mountItem({ status: 'awaiting_approval' });
        await nextTick();
        await expandPanel(wrapper);

        expect(statusText(wrapper)).toBe('待审批');
    });

    it('user gets the status coloured for each outcome', async () => {
        const wrapper = mountItem({ status: 'error' });
        await nextTick();
        await expandPanel(wrapper);

        expect(wrapper.get('.tool-call-bash-status-text').classes()).toContain(
            'tool-call-bash-status--error'
        );
    });
});

describe('user reads the output of a finished command', () => {
    it('user sees the command output', async () => {
        const wrapper = mountItem({ result: createBashResult('hello world') });
        await nextTick();
        await expandPanel(wrapper);

        expect(output(wrapper).text()).toBe('hello world');
    });

    it('user is told there is no output for a successful command', async () => {
        const wrapper = mountItem({ result: createBashResult('') });
        await nextTick();
        await expandPanel(wrapper);
        await expandPanel(wrapper);

        expect(output(wrapper).text()).toBe('无输出');
        expect(output(wrapper).classes()).toContain('tool-call-bash-output--empty');
    });

    it('user is told there is no error text when a failed command produced none', async () => {
        const wrapper = mountItem({ status: 'error', result: createBashResult('') });
        await nextTick();
        await expandPanel(wrapper);

        expect(output(wrapper).text()).toBe('无错误输出');
    });

    it('user sees the failure text when a failed command did produce some', async () => {
        const wrapper = mountItem({
            status: 'error',
            result: createBashResult('command not found'),
        });
        await nextTick();
        await expandPanel(wrapper);

        expect(output(wrapper).text()).toBe('command not found');
    });

    it('user sees a running command marked as still running when nothing has arrived', async () => {
        const wrapper = mountItem({ status: 'executing', result: createBashResult('') });
        await nextTick();
        await expandPanel(wrapper);

        expect(output(wrapper).text()).toBe('命令执行中...');
    });

    it('user sees the live output of a running command as soon as it arrives', async () => {
        const wrapper = mountItem({
            status: 'executing',
            result: createBashResult('partial line'),
        });
        await nextTick();

        expect(output(wrapper).text()).toBe('partial line');
    });

    it('user sees a cancelled command say it was cancelled when it printed nothing', async () => {
        const wrapper = mountItem({ status: 'cancelled', result: createBashResult('') });
        await nextTick();
        await expandPanel(wrapper);

        expect(output(wrapper).text()).toBe('命令已取消');
    });

    it('user sees the partial output of a cancelled command rather than only the label', async () => {
        const wrapper = mountItem({ status: 'cancelled', result: createBashResult('half done') });
        await nextTick();
        await expandPanel(wrapper);

        expect(output(wrapper).text()).toBe('half done');
    });

    it('user is told to approve before anything runs', async () => {
        const wrapper = mountItem({ status: 'awaiting_approval', result: createBashResult('') });
        await nextTick();

        expect(output(wrapper).text()).toContain('等待用户批准');
    });

    it('user is told a rejected command never ran', async () => {
        const wrapper = mountItem({ status: 'rejected', result: createBashResult('') });
        await nextTick();
        await expandPanel(wrapper);

        expect(output(wrapper).text()).toContain('拒绝');
    });

    it('user gets the output marked as not eligible for translation', async () => {
        const wrapper = mountItem({ result: createBashResult('raw output') });
        await nextTick();
        await expandPanel(wrapper);

        expect(output(wrapper).attributes('translate')).toBe('no');
    });

    it('user gets the empty notice left translatable', async () => {
        const wrapper = mountItem({ result: createBashResult('') });
        await nextTick();
        await expandPanel(wrapper);

        expect(output(wrapper).attributes('translate')).toBeUndefined();
    });
});

describe('user reads the command itself', () => {
    it('user sees the command split into coloured parts', async () => {
        const wrapper = mountItem({
            arguments: { command: 'git commit -m "message" --no-verify' },
        });
        await nextTick();
        await expandPanel(wrapper);

        expect(wrapper.find('.tool-call-bash-token--command').text()).toBe('git');
        expect(wrapper.find('.tool-call-bash-token--flag').text()).toBe('-m');
        expect(wrapper.find('.tool-call-bash-token--string').text()).toBe('"message"');
    });

    it('user sees a variable in the command highlighted apart from the rest', async () => {
        const wrapper = mountItem({
            arguments: { command: 'echo $HOME' },
        });
        await nextTick();
        await expandPanel(wrapper);

        expect(wrapper.find('.tool-call-bash-token--variable').text()).toBe('$HOME');
    });

    it('user sees a braced variable highlighted too', async () => {
        const wrapper = mountItem({ arguments: { command: 'echo ${PATH}' } });
        await nextTick();
        await expandPanel(wrapper);

        expect(wrapper.find('.tool-call-bash-token--variable').text()).toBe('${PATH}');
    });

    it('user sees a path highlighted apart from plain arguments', async () => {
        const wrapper = mountItem({
            arguments: { command: 'cd D:\\Project\\TouchAI' },
        });
        await nextTick();
        await expandPanel(wrapper);

        expect(wrapper.find('.tool-call-bash-token--path').text()).toBe('D:\\Project\\TouchAI');
    });

    it('user sees a relative path highlighted as a path', async () => {
        const wrapper = mountItem({ arguments: { command: 'cat ./notes.txt' } });
        await nextTick();
        await expandPanel(wrapper);

        expect(wrapper.find('.tool-call-bash-token--path').text()).toBe('./notes.txt');
    });

    it('user sees a home-relative path highlighted as a path', async () => {
        const wrapper = mountItem({ arguments: { command: 'ls ~/docs' } });
        await nextTick();
        await expandPanel(wrapper);

        expect(wrapper.find('.tool-call-bash-token--path').text()).toBe('~/docs');
    });

    it('user sees shell operators separated from the words', async () => {
        const wrapper = mountItem({ arguments: { command: 'a && b | c' } });
        await nextTick();
        await expandPanel(wrapper);

        const operators = wrapper
            .findAll('.tool-call-bash-token--operator')
            .map((node) => node.text());
        expect(operators).toEqual(['&&', '|']);
    });

    it('user sees a redirect treated as an operator rather than as text', async () => {
        const wrapper = mountItem({ arguments: { command: 'ls > out.txt 2> err.txt' } });
        await nextTick();
        await expandPanel(wrapper);

        const operators = wrapper
            .findAll('.tool-call-bash-token--operator')
            .map((node) => node.text());
        expect(operators).toEqual(['>', '2>']);
    });

    it('user sees a plain argument distinguished from the command and paths', async () => {
        const wrapper = mountItem({ arguments: { command: 'npm run build' } });
        await nextTick();
        await expandPanel(wrapper);

        expect(wrapper.find('.tool-call-bash-token--command').text()).toBe('npm');
        expect(wrapper.findAll('.tool-call-bash-token--plain').map((n) => n.text())).toEqual([
            'run',
            'build',
        ]);
    });

    it('user sees the fallback command text when the tool reported none', async () => {
        const wrapper = mountItem({ arguments: {} }, { summaryText: '' });
        await nextTick();
        await expandPanel(wrapper);

        expect(wrapper.get('.tool-call-bash-command').text()).toContain('命令');
    });

    it('user sees the summary used as the command when the arguments are empty', async () => {
        const wrapper = mountItem({ arguments: {} }, { summaryText: 'ls -la' });
        await nextTick();
        await expandPanel(wrapper);

        expect(wrapper.find('.tool-call-bash-token--command').text()).toBe('ls');
    });

    it('user gets the command kept long by default and can reveal the rest', async () => {
        const wrapper = mountItem({ arguments: { command: 'a'.repeat(200) } });
        await nextTick();
        await expandPanel(wrapper);
        const toggle = wrapper.get('.tool-call-bash-command-toggle');
        expect(toggle.attributes('aria-expanded')).toBe('false');
        expect(wrapper.get('.tool-call-bash-command').classes()).toContain(
            'tool-call-bash-command--collapsed'
        );

        await toggle.trigger('click');
        await nextTick();

        expect(toggle.attributes('aria-expanded')).toBe('true');
        expect(wrapper.get('.tool-call-bash-command').classes()).toContain(
            'tool-call-bash-command--expanded'
        );
    });

    it('user gets the command folded back by clicking it again', async () => {
        const wrapper = mountItem();
        await nextTick();
        await expandPanel(wrapper);
        const toggle = wrapper.get('.tool-call-bash-command-toggle');

        await toggle.trigger('click');
        await toggle.trigger('click');
        await nextTick();

        expect(toggle.attributes('aria-expanded')).toBe('false');
    });

    it('user gets the command folded away when they collapse the whole panel', async () => {
        const wrapper = mountItem();
        await nextTick();
        await expandPanel(wrapper);
        await wrapper.get('.tool-call-bash-command-toggle').trigger('click');

        await wrapper.get('.tool-call-log-button').trigger('click');
        await nextTick();
        await wrapper.get('.tool-call-log-button').trigger('click');
        await nextTick();

        expect(wrapper.get('.tool-call-bash-command-toggle').attributes('aria-expanded')).toBe(
            'false'
        );
    });

    it('user gets the command marked as not eligible for translation', async () => {
        const wrapper = mountItem();
        await nextTick();
        await expandPanel(wrapper);

        expect(wrapper.get('.tool-call-bash-token--command').attributes('translate')).toBe('no');
    });
});

describe('user reads the panel header', () => {
    it('user sees the shell the command ran in', async () => {
        const wrapper = mountItem({ result: createBashResult('done', { shell: 'bash' }) });
        await nextTick();
        await expandPanel(wrapper);

        expect(wrapper.get('.tool-call-bash-shell-text').text()).toBe('bash');
    });

    it('user sees a shell name kept out of translation', async () => {
        const wrapper = mountItem({ result: createBashResult('done', { shell: 'bash' }) });
        await nextTick();
        await expandPanel(wrapper);

        expect(wrapper.get('.tool-call-bash-shell-text').attributes('translate')).toBe('no');
    });

    it('user gets PowerShell assumed when the result never named a shell', async () => {
        const wrapper = mountItem({ result: 'no header at all' });
        await nextTick();
        await expandPanel(wrapper);

        expect(wrapper.get('.tool-call-bash-shell-text').text()).toBe('PowerShell');
        expect(wrapper.get('.tool-call-bash-shell-text').attributes('translate')).toBeUndefined();
    });

    it('user sees a marker when the output was compressed', async () => {
        const wrapper = mountItem({
            result: createBashResult('done', { compressed: true }),
        });
        await nextTick();
        await expandPanel(wrapper);

        expect(wrapper.find('.tool-call-compressed-icon').exists()).toBe(true);
    });

    it('user sees no marker for output that was not compressed', async () => {
        const wrapper = mountItem();
        await nextTick();
        await expandPanel(wrapper);

        expect(wrapper.find('.tool-call-compressed-icon').exists()).toBe(false);
    });

    it('user sees the duration from the tool call when it reported one', async () => {
        const wrapper = mountItem({ status: 'completed', durationMs: 65_000 });
        await nextTick();

        expect(wrapper.get('.tool-call-log-duration').text()).toContain('1m 5s');
    });

    it('user sees the duration from the result header when the tool call had none', async () => {
        const wrapper = mountItem({
            status: 'completed',
            durationMs: undefined,
            result: createBashResult('done', { duration: '1500ms' }),
        });
        await nextTick();

        expect(wrapper.get('.tool-call-log-duration').text()).toContain('2s');
    });

    it('user sees the duration the caller passed in as a last resort', async () => {
        const wrapper = mountItem(
            { status: 'completed', durationMs: undefined, result: 'no header' },
            { durationText: '2s' }
        );
        await nextTick();

        expect(wrapper.get('.tool-call-log-duration').text()).toContain('2s');
    });

    it('user gets a sub-second command rounded up to one second rather than shown as 0s', async () => {
        const wrapper = mountItem({ status: 'completed', durationMs: 200 });
        await nextTick();

        expect(wrapper.get('.tool-call-log-duration').text()).toContain('1s');
    });
});
