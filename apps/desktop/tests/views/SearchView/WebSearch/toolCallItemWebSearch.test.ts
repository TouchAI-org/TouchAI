import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';

import type { ToolCallInfo } from '@/types/session';
import ToolCallItem from '@/views/SearchView/components/ConversationPanel/components/ToolCallItem.vue';

vi.mock('@components/MotionCollapse.vue', () => ({
    default: {
        name: 'MotionCollapse',
        props: ['open'],
        template: '<div v-if="open"><slot /></div>',
    },
}));

vi.mock('@/i18n', () => ({
    t: (key: string) => key,
    tt: (key: string) => key,
}));

vi.mock('@/services/BuiltInToolService/presentation', () => ({
    buildBuiltInToolConversationPresentation: () => ({
        verb: 'Ran',
        content: 'command',
    }),
    resolveBuiltInToolConversationSemantic: () => ({ action: 'run', target: 'command' }),
}));

function makeToolCall(overrides: Partial<ToolCallInfo>): ToolCallInfo {
    return {
        id: 'call-1',
        name: 'tool',
        namespacedName: 'builtin__web_fetch',
        source: 'builtin',
        sourceLabel: '内置工具',
        arguments: {},
        status: 'executing',
        ...overrides,
    };
}

describe('user sees the web search card while a search runs', () => {
    it('user sees the skeleton card while web_search is executing', () => {
        const wrapper = mount(ToolCallItem, {
            props: {
                toolCall: makeToolCall({
                    namespacedName: 'builtin__web_search',
                    status: 'executing',
                }),
            },
        });

        expect(wrapper.findAll('[data-slot="web-search-skeleton"]')).toHaveLength(4);
    });

    it('user does not render the skeleton card for other builtin tools while executing', () => {
        // 回归：曾经任何内置工具在 executing 时都会被渲染成搜索骨架卡，
        // 导致 web_fetch / bash 在运行中变成一排 loading 占位。
        for (const toolId of ['web_fetch', 'bash', 'read', 'file_search']) {
            const wrapper = mount(ToolCallItem, {
                props: {
                    toolCall: makeToolCall({
                        namespacedName: `builtin__${toolId}`,
                        status: 'executing',
                    }),
                },
            });

            expect(wrapper.findAll('[data-slot="web-search-skeleton"]')).toHaveLength(0);
            expect(wrapper.find('.web-search-sources').exists()).toBe(false);
        }
    });

    it('user sees source cards for a finished web_search with a payload', () => {
        const wrapper = mount(ToolCallItem, {
            props: {
                toolCall: makeToolCall({
                    namespacedName: 'builtin__web_search',
                    status: 'completed',
                    structuredPayload: {
                        kind: 'web_search_sources',
                        provider: 'deepseek',
                        query: 'q',
                        status: 'done',
                        sources: [
                            {
                                id: 's1',
                                index: 1,
                                title: 'Example',
                                url: 'https://example.com/a',
                                siteName: 'example.com',
                            },
                        ],
                    },
                }),
            },
        });

        expect(wrapper.findAll('[data-slot="web-search-source"]')).toHaveLength(1);
        expect(wrapper.findAll('[data-slot="web-search-skeleton"]')).toHaveLength(0);
    });
});
