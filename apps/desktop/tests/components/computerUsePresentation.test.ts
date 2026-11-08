import { enableAutoUnmount, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';
import type { ToolCallInfo } from '@/types/session';
import ToolCallItem from '@/views/SearchView/components/ConversationPanel/components/ToolCallItem.vue';

enableAutoUnmount(afterEach);
afterEach(() => setLocale('zh-CN'));

function mountCall(
    argumentsValue: Record<string, unknown>,
    status: ToolCallInfo['status'] = 'executing'
) {
    return mount(ToolCallItem, {
        props: {
            toolCall: {
                id: 'computer-call',
                source: 'builtin',
                name: 'computer_use',
                namespacedName: 'builtin__computer_use',
                arguments: argumentsValue,
                status,
                durationMs: 340,
            },
        },
    });
}

describe('computer use conversation activity', () => {
    it('user given a desktop action when reading the conversation then sees the existing tool log row with a pointer icon', () => {
        const wrapper = mountCall({ action: 'click' });
        const line = wrapper.get('.tool-call-log-line');
        expect(line.find('.tool-call-log-icon svg').exists()).toBe(true);
        expect(line.get('.tool-call-log-verb').text()).toBe('正在点击');
        expect(line.get('.tool-call-log-duration').text()).toBe('(340ms)');
        expect(wrapper.find('button').exists()).toBe(false);
    });

    it.each([
        [{ action: 'observe' }, '查看窗口'],
        [{ action: 'type', text: 'private input' }, '输入文本'],
        [{ action: 'hotkey', keys: ['ctrl', 's'] }, '按快捷键'],
        [{ action: 'scroll', direction: 'down' }, '滚动'],
        [{ action: 'call', tool: 'set_window_frame', arguments: { width: 900 } }, '调整窗口'],
        [{ action: 'call', tool: 'browser_download', arguments: {} }, '下载文件'],
        [{ action: 'call', arguments: { tool: 'browser_download', arguments: {} } }, '下载文件'],
        [
            {
                action: 'run_steps',
                arguments: { steps: [{ tool: 'press_key', args: { key: 'Enter' } }] },
            },
            '执行批量操作',
        ],
        [{ action: 'run_script', arguments: { script: 'return 1' } }, '运行自动化脚本'],
    ])('user given operation %j when reading its activity then sees %s', (args, label) => {
        const wrapper = mountCall(args);
        expect(wrapper.text()).toContain(label);
        expect(wrapper.text()).not.toContain('private input');
    });

    it.each([
        ['executing', '正在点击'],
        ['completed', '点击完成'],
        ['error', '点击失败'],
        ['awaiting_approval', '等待批准：点击'],
        ['rejected', '已拒绝：点击'],
        ['cancelled', '已取消：点击'],
    ] as const)('user given %s when reading a click then sees %s', (status, label) => {
        expect(mountCall({ action: 'click' }, status).text()).toContain(label);
    });

    it('user given a batch when reading its activity then sees the target and step count', () => {
        const wrapper = mountCall({
            action: 'run_steps',
            arguments: { app: 'Notepad', steps: [{ tool: 'press_key' }, { tool: 'type_text' }] },
        });
        expect(wrapper.text()).toContain('Notepad · 2 步');
    });

    it('user given an English locale when reading a native action then sees localized wording', () => {
        setLocale('en-US');
        const wrapper = mountCall({ action: 'call', tool: 'type_text', arguments: {} });
        expect(wrapper.text()).toContain('In progress: Type text');
    });
});
