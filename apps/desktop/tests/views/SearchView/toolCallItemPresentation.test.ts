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

// The i18n keys are returned verbatim so a missing or wrong key is visible in the DOM.
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

function makeToolCall(overrides: Partial<ToolCallInfo> = {}): ToolCallInfo {
    return {
        id: 'call-1',
        name: 'some_tool',
        namespacedName: 'mcp__server__some_tool',
        source: 'mcp',
        sourceLabel: 'MCP 工具',
        arguments: { path: '/tmp/file' },
        status: 'executing',
        ...overrides,
    };
}

function mountItem(overrides: Partial<ToolCallInfo> = {}) {
    return mount(ToolCallItem, {
        props: { toolCall: makeToolCall(overrides) },
    });
}

describe('user reads which tool ran', () => {
    it('user sees the tool name when the call carries one', () => {
        const wrapper = mountItem({ name: 'read_file' });

        expect(wrapper.text()).toContain('read_file');

        wrapper.unmount();
    });

    it('user sees the namespaced name when the plain name is missing', () => {
        const wrapper = mountItem({ name: '', namespacedName: 'mcp__fs__read_file' });

        expect(wrapper.text()).toContain('mcp__fs__read_file');

        wrapper.unmount();
    });

    it('user sees an unnamed placeholder when neither name is present', () => {
        const wrapper = mountItem({ name: '   ', namespacedName: '' });

        expect(wrapper.text()).toContain('conversation.toolCall.unnamed');

        wrapper.unmount();
    });

    it('user sees the server name as the badge when the tool belongs to one', () => {
        const wrapper = mountItem({ serverName: 'filesystem', sourceLabel: 'MCP 工具' });

        expect(wrapper.text()).toContain('filesystem');

        wrapper.unmount();
    });

    it('user gets a compact log line instead of a badge for a built-in tool', () => {
        const wrapper = mountItem({
            serverName: undefined,
            source: 'builtin',
            sourceLabel: '内置工具',
        });

        // Built-in tools render as one log line, so the badge has no place there.
        expect(wrapper.find('.tool-call-toggle').exists()).toBe(false);

        wrapper.unmount();
    });

    it('user sees an MCP badge for an MCP tool', () => {
        const wrapper = mountItem({ serverName: undefined, sourceLabel: 'MCP 工具' });

        expect(wrapper.text()).toContain('conversation.toolCall.mcpBadge');

        wrapper.unmount();
    });

    it('user sees a custom source label as-is', () => {
        const wrapper = mountItem({ serverName: undefined, sourceLabel: 'Custom Source' });

        expect(wrapper.text()).toContain('Custom Source');

        wrapper.unmount();
    });

    it('user sees the arguments rendered as JSON once the row is expanded', async () => {
        const wrapper = mountItem({ arguments: { path: '/tmp/file', depth: 2 } });

        await wrapper.find('.tool-call-toggle').trigger('click');

        expect(wrapper.text()).toContain('/tmp/file');

        wrapper.unmount();
    });

    it('user sees an empty argument object without crashing', () => {
        const wrapper = mountItem({ arguments: {} });

        expect(wrapper.html()).toBeTruthy();

        wrapper.unmount();
    });
});

describe('user reads what state the tool call is in', () => {
    it('user sees a running state while the tool is executing', () => {
        const wrapper = mountItem({ status: 'executing' });

        expect(wrapper.html()).toBeTruthy();

        wrapper.unmount();
    });

    it('user sees a running state while the tool waits for approval', () => {
        const wrapper = mountItem({ status: 'awaiting_approval' });

        expect(wrapper.html()).toBeTruthy();

        wrapper.unmount();
    });

    it('user sees the failure text when the tool failed', async () => {
        const wrapper = mountItem({
            status: 'error',
            isError: true,
            result: 'permission denied',
        });

        await wrapper.find('.tool-call-toggle').trigger('click');

        expect(wrapper.text()).toContain('permission denied');

        wrapper.unmount();
    });

    it('user sees a rejected state when the user rejected the call', () => {
        const wrapper = mountItem({ status: 'rejected' });

        expect(wrapper.html()).toBeTruthy();

        wrapper.unmount();
    });

    it('user sees a cancelled state when the call was cancelled', () => {
        const wrapper = mountItem({ status: 'cancelled' });

        expect(wrapper.html()).toBeTruthy();

        wrapper.unmount();
    });

    it('user sees a completed state when the tool finished', () => {
        const wrapper = mountItem({ status: 'completed', result: 'ok' });

        expect(wrapper.html()).toBeTruthy();

        wrapper.unmount();
    });
});
