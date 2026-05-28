import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import type { ToolCallInfo } from '@/types/session';
import ToolCallItem from '@/views/SearchView/components/ConversationPanel/components/ToolCallItem.vue';

vi.mock('@components/AppIcon.vue', () => ({
    default: {
        name: 'AppIcon',
        props: ['name'],
        template: '<span data-testid="app-icon" />',
    },
}));

function createToolCall(overrides: Partial<ToolCallInfo> = {}): ToolCallInfo {
    return {
        id: 'call-1',
        name: 'search',
        namespacedName: 'mcp__1__search',
        source: 'mcp',
        sourceLabel: 'MCP 工具',
        arguments: {},
        result: 'done',
        status: 'completed',
        ...overrides,
    };
}

describe('ToolCallItem i18n', () => {
    beforeEach(() => {
        setLocale('zh-CN');
    });

    it('localizes known source labels restored from history', () => {
        setLocale('en-US');

        const wrapper = mount(ToolCallItem, {
            props: {
                toolCall: createToolCall(),
            },
        });

        const badge = wrapper.get('.tool-call-server');
        expect(badge.text()).toBe('MCP tool');
        expect(badge.attributes('data-no-i18n')).toBeUndefined();
        expect(wrapper.text()).not.toContain('MCP 工具');
    });

    it('keeps real server names as user data instead of translating them', () => {
        setLocale('en-US');

        const wrapper = mount(ToolCallItem, {
            props: {
                toolCall: createToolCall({
                    serverName: '设置服务器',
                    sourceLabel: '设置服务器 MCP 工具',
                }),
            },
        });

        const badge = wrapper.get('.tool-call-server');
        expect(badge.text()).toBe('设置服务器');
        expect(badge.attributes('data-no-i18n')).toBe('true');
        expect(badge.attributes('translate')).toBe('no');
    });
});
