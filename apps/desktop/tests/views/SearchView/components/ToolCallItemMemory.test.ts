import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';

import ToolCallItem from '@/views/SearchView/components/ConversationPanel/components/ToolCallItem.vue';

vi.mock('@components/AppIcon.vue', () => ({
    default: {
        name: 'AppIconStub',
        props: ['name'],
        template: '<span data-testid="app-icon" :data-name="name" />',
    },
}));

describe('ToolCallItem memory rendering', () => {
    it('renders memory reads as an expandable built-in log entry', async () => {
        const wrapper = mount(ToolCallItem, {
            props: {
                toolCall: {
                    id: 'tool-call-memory-1',
                    name: 'memory',
                    namespacedName: 'builtin__memory',
                    source: 'builtin',
                    sourceLabel: '内置工具',
                    arguments: {
                        action: 'read',
                        ids: [11],
                    },
                    builtinPresentation: {
                        verb: '已读取',
                        content: '记忆(桌面工作方式)',
                    },
                    result: '1. 先观察桌面窗口\n2. 再检查托盘图标',
                    status: 'completed',
                    durationMs: 320,
                },
            },
        });

        expect(wrapper.text()).toContain('已读取 记忆(桌面工作方式)');
        expect(wrapper.text()).not.toContain('参数');
        expect(wrapper.text()).not.toContain('结果');

        await wrapper.get('button[aria-expanded="false"]').trigger('click');

        expect(wrapper.find('button[aria-expanded="true"]').exists()).toBe(true);
        expect(wrapper.text()).toContain('记忆内容');
        expect(wrapper.text()).toContain('1. 先观察桌面窗口');
        expect(wrapper.text()).toContain('2. 再检查托盘图标');
    });

    it('keeps non-read memory actions on the generic built-in log rendering', () => {
        const wrapper = mount(ToolCallItem, {
            props: {
                toolCall: {
                    id: 'tool-call-memory-2',
                    name: 'memory',
                    namespacedName: 'builtin__memory',
                    source: 'builtin',
                    sourceLabel: '内置工具',
                    arguments: {
                        action: 'upsert',
                        title: '桌面工作方式',
                    },
                    builtinConversationSemantic: {
                        action: 'update',
                        target: '记忆(桌面工作方式)',
                    },
                    builtinPresentation: {
                        verb: '已更新',
                        content: '记忆(桌面工作方式)',
                    },
                    result: 'Memory updated.',
                    status: 'completed',
                    durationMs: 120,
                },
            },
        });

        expect(wrapper.text()).toContain('已更新 记忆(桌面工作方式)');
        expect(wrapper.find('button[aria-expanded]').exists()).toBe(false);
        expect(wrapper.text()).not.toContain('记忆内容');
    });
});
