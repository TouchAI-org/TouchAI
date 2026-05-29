import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';

import { setLocale } from '@/i18n';
import type { ToolCallInfo } from '@/types/session';
import BuiltInMemoryToolCallItem from '@/views/SearchView/components/ConversationPanel/components/BuiltInMemoryToolCallItem.vue';
import ToolCallItem from '@/views/SearchView/components/ConversationPanel/components/ToolCallItem.vue';

function createMemoryToolCall(patch: Partial<ToolCallInfo> = {}): ToolCallInfo {
    return {
        id: 'call-memory',
        name: 'Memory',
        namespacedName: 'builtin__memory',
        source: 'builtin',
        sourceLabel: '内置工具',
        arguments: { action: 'read', ids: [3] },
        builtinPresentation: {
            verb: '已读取',
            content: '记忆(桌面 Agent 工作方式)',
        },
        result: 'memory_content_untrusted: "优先观察真实桌面上下文。"',
        status: 'completed',
        durationMs: 12,
        ...patch,
    };
}

describe('ToolCallItem memory built-in display', () => {
    beforeEach(() => {
        setLocale('zh-CN');
    });

    it('shows read memory title and expands to show result content', async () => {
        const wrapper = mount(ToolCallItem, {
            props: {
                toolCall: createMemoryToolCall({
                    result: [
                        'Found 1 memory.',
                        '',
                        '1. memory_id: 3',
                        '   title_untrusted: "桌面 Agent 工作方式"',
                        '   memory_content_untrusted: "优先观察真实桌面上下文。"',
                    ].join('\n'),
                }),
            },
            global: {
                stubs: {
                    AppIcon: true,
                    transition: false,
                },
            },
        });

        expect(wrapper.text()).toContain('已读取 记忆(桌面 Agent 工作方式)');
        expect(wrapper.text()).not.toContain('长期记忆');
        expect(wrapper.text()).not.toContain('memory_content_untrusted');

        await wrapper.get('button').trigger('click');
        await nextTick();

        expect(wrapper.text()).toContain('memory_content_untrusted');
        expect(wrapper.text()).toContain('优先观察真实桌面上下文');
    });

    it('renders the localized en-US memory summary in the ToolCallItem UI', () => {
        setLocale('en-US');

        const wrapper = mount(ToolCallItem, {
            props: {
                toolCall: createMemoryToolCall({
                    builtinPresentation: {
                        verb: 'Read',
                        content: 'Memory (Desktop Agent workflow)',
                    },
                }),
            },
            global: {
                stubs: {
                    AppIcon: true,
                    transition: false,
                },
            },
        });

        expect(wrapper.text()).toContain('Read Memory (Desktop Agent workflow)');
        expect(wrapper.text()).not.toContain('Read 记忆(');
        expect(wrapper.text()).not.toContain('Long-term memory');
    });

    it.each([
        ['awaiting_approval', '等待用户批准后继续执行...', '等待批准'],
        ['executing', '记忆读取中...', '运行中'],
        ['rejected', '用户已拒绝此次执行', '已拒绝'],
        ['cancelled', '请求已取消', '已取消'],
        ['error', '无错误输出', '失败'],
        ['completed', '无输出', '成功'],
    ] as const)('shows %s fallback content when expanded', async (status, output, statusText) => {
        const wrapper = mount(BuiltInMemoryToolCallItem, {
            props: {
                toolCall: createMemoryToolCall({ status, result: '' }),
                verbText: '已读取',
                summaryText: '',
                durationText: null,
            },
            global: {
                stubs: {
                    transition: false,
                },
            },
        });

        await wrapper.get('button').trigger('click');
        await nextTick();

        expect(wrapper.text()).toContain(output);
        expect(wrapper.text()).toContain(statusText);
    });
});
