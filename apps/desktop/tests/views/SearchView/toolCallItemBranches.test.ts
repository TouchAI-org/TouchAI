import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';

import type { ToolCallInfo } from '@/types/session';
import ToolCallItem from '@/views/SearchView/components/ConversationPanel/components/ToolCallItem.vue';

/**
 * ToolCallItem renders four different shapes: a built-in tool with its own card,
 * the web-search card, a compact built-in log line, and the expandable generic row.
 * These tests drive the conditions that choose between them and the small
 * formatters that the user reads (status word, duration, result placeholder).
 */
vi.mock('@components/MotionCollapse.vue', () => ({
    default: {
        name: 'MotionCollapse',
        props: ['open'],
        template: '<div v-if="open"><slot /></div>',
    },
}));

// Keys come back verbatim so a missing or wrong key is visible in the assertion.
vi.mock('@/i18n', () => ({
    t: (key: string) => key,
    tt: (key: string) => key,
}));

vi.mock('@/services/BuiltInToolService/presentation', () => ({
    buildBuiltInToolConversationPresentation: () => ({ verb: 'Ran', content: 'command' }),
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
        status: 'completed',
        ...overrides,
    };
}

function mountItem(overrides: Partial<ToolCallInfo> = {}) {
    return mount(ToolCallItem, { props: { toolCall: makeToolCall(overrides) } });
}

async function expand(wrapper: ReturnType<typeof mountItem>) {
    await wrapper.find('.tool-call-toggle').trigger('click');
}

describe('when the tool call carries a duration', () => {
    it('user sees the duration in milliseconds for a very fast call', () => {
        const wrapper = mountItem({ durationMs: 850 });

        expect(wrapper.text()).toContain('850ms');

        wrapper.unmount();
    });

    it('user sees the duration in seconds once it passes a second', () => {
        const wrapper = mountItem({ durationMs: 4500 });

        expect(wrapper.text()).toContain('4500ms');

        wrapper.unmount();
    });

    it('user sees no duration at all when the call never reported one', () => {
        const wrapper = mountItem({ durationMs: undefined });

        expect(wrapper.find('.tool-call-duration').exists()).toBe(false);

        wrapper.unmount();
    });
});

describe('when a built-in tool finished and reports a duration', () => {
    it('user sees the elapsed time next to the log line', () => {
        const wrapper = mountItem({
            source: 'builtin',
            sourceLabel: '内置工具',
            namespacedName: 'builtin__web_fetch',
            status: 'completed',
            durationMs: 1200,
        });

        expect(wrapper.text()).toContain('1s');

        wrapper.unmount();
    });

    it('user sees whole minutes when the call ran for exactly a minute', () => {
        const wrapper = mountItem({
            source: 'builtin',
            sourceLabel: '内置工具',
            namespacedName: 'builtin__web_fetch',
            status: 'completed',
            durationMs: 60_000,
        });

        expect(wrapper.text()).toContain('1m');

        wrapper.unmount();
    });

    it('user sees minutes and seconds when the call ran past a minute', () => {
        const wrapper = mountItem({
            source: 'builtin',
            sourceLabel: '内置工具',
            namespacedName: 'builtin__web_fetch',
            status: 'completed',
            durationMs: 95_000,
        });

        expect(wrapper.text()).toContain('1m 35s');

        wrapper.unmount();
    });

    it('user sees no duration mark when the built-in call reported a negative time', () => {
        const wrapper = mountItem({
            source: 'builtin',
            sourceLabel: '内置工具',
            namespacedName: 'builtin__web_fetch',
            status: 'completed',
            durationMs: -5,
        });

        expect(wrapper.find('.tool-call-log-duration').exists()).toBe(false);

        wrapper.unmount();
    });

    it('user sees no duration mark for a non-finite time', () => {
        const wrapper = mountItem({
            source: 'builtin',
            sourceLabel: '内置工具',
            namespacedName: 'builtin__web_fetch',
            status: 'completed',
            durationMs: Number.POSITIVE_INFINITY,
        });

        expect(wrapper.find('.tool-call-log-duration').exists()).toBe(false);

        wrapper.unmount();
    });
});

describe('when the tool has no display name available', () => {
    it('user still gets a readable log line built from the fallback verb', () => {
        const wrapper = mountItem({
            source: 'builtin',
            sourceLabel: '内置工具',
            namespacedName: '',
            name: '',
            status: 'completed',
        });

        // With no name at all the line still renders a verb rather than an empty row.
        expect(wrapper.find('.tool-call-log-line').exists()).toBe(true);
        expect(wrapper.find('.tool-call-log-verb').text().length).toBeGreaterThan(0);

        wrapper.unmount();
    });
});

describe('when the built-in tool is the browser tool', () => {
    it('user sees the browser icon instead of a verb', () => {
        const wrapper = mountItem({
            source: 'builtin',
            sourceLabel: '内置工具',
            namespacedName: 'builtin__browser',
            name: 'browser',
            status: 'completed',
        });

        expect(wrapper.find('.tool-call-log-icon').exists()).toBe(true);
        expect(wrapper.find('.tool-call-log-verb').exists()).toBe(false);

        wrapper.unmount();
    });

    it('user sees a verb instead of the icon for a non-browser built-in tool', () => {
        const wrapper = mountItem({
            source: 'builtin',
            sourceLabel: '内置工具',
            namespacedName: 'builtin__web_fetch',
            name: 'web_fetch',
            status: 'completed',
        });

        expect(wrapper.find('.tool-call-log-verb').exists()).toBe(true);
        expect(wrapper.find('.tool-call-log-icon').exists()).toBe(false);

        wrapper.unmount();
    });
});

describe('when the generic row shows the calls status', () => {
    it('user sees the waiting text while the call waits for approval', () => {
        const wrapper = mountItem({ status: 'awaiting_approval' });

        expect(wrapper.text()).toContain('conversation.toolCall.waitingApproval');

        wrapper.unmount();
    });

    it('user sees a pulse while the call is running', () => {
        const wrapper = mountItem({ status: 'executing' });

        expect(wrapper.find('.tool-call-pulse').exists()).toBe(true);

        wrapper.unmount();
    });

    it('user sees the failed text when the call errored', () => {
        const wrapper = mountItem({ status: 'error', isError: true });

        expect(wrapper.text()).toContain('common.failed');

        wrapper.unmount();
    });

    it('user sees the rejected text when the call was rejected', () => {
        const wrapper = mountItem({ status: 'rejected' });

        expect(wrapper.text()).toContain('common.rejected');

        wrapper.unmount();
    });

    it('user sees the cancelled text when the call was cancelled', () => {
        const wrapper = mountItem({ status: 'cancelled' });

        expect(wrapper.text()).toContain('common.cancelled');

        wrapper.unmount();
    });

    it('user sees the done text when the call completed', () => {
        const wrapper = mountItem({ status: 'completed' });

        expect(wrapper.text()).toContain('common.done');

        wrapper.unmount();
    });
});

describe('when the user expands a finished call', () => {
    it('user sees a placeholder instead of an empty result for a silent success', async () => {
        const wrapper = mountItem({ status: 'completed', result: '' });
        await expand(wrapper);

        expect(wrapper.text()).toContain('conversation.toolCall.noOutput');

        wrapper.unmount();
    });

    it('user is told there was no error output when a failed call has no message', async () => {
        const wrapper = mountItem({ status: 'error', isError: true, result: '   ' });
        await expand(wrapper);

        expect(wrapper.text()).toContain('conversation.toolCall.noErrorOutput');

        wrapper.unmount();
    });

    it('user is told the call was rejected rather than shown an empty result', async () => {
        const wrapper = mountItem({ status: 'rejected', result: '' });
        await expand(wrapper);

        expect(wrapper.text()).toContain('conversation.toolCall.userRejected');

        wrapper.unmount();
    });

    it('user is told the request was cancelled rather than shown an empty result', async () => {
        const wrapper = mountItem({ status: 'cancelled', result: '' });
        await expand(wrapper);

        expect(wrapper.text()).toContain('common.requestCancelled');

        wrapper.unmount();
    });

    it('user sees the raw result text when the call produced one', async () => {
        const wrapper = mountItem({ status: 'completed', result: 'the actual output' });
        await expand(wrapper);

        expect(wrapper.text()).toContain('the actual output');
        // A real payload is not replaced by the placeholder.
        expect(wrapper.text()).not.toContain('conversation.toolCall.noOutput');

        wrapper.unmount();
    });

    it('user gets the raw result text kept as-is rather than translated', async () => {
        const wrapper = mountItem({ status: 'completed', result: 'raw output' });
        await expand(wrapper);

        const payload = wrapper.find('[data-no-i18n="true"]');
        expect(payload.exists()).toBe(true);

        wrapper.unmount();
    });
});

describe('when the arguments cannot be serialised', () => {
    it('user gets a readable fallback instead of a crash', async () => {
        const circular: Record<string, unknown> = { a: 1 };
        circular.self = circular;

        const wrapper = mountItem({ arguments: circular });
        await expand(wrapper);

        expect(wrapper.text()).toContain('[object Object]');

        wrapper.unmount();
    });
});

describe('when the user clicks the built-in log line', () => {
    it('user gets no text selection started on a built-in tool without its own card', async () => {
        const wrapper = mountItem({
            source: 'builtin',
            sourceLabel: '内置工具',
            namespacedName: 'builtin__web_fetch',
            name: 'web_fetch',
            status: 'completed',
        });

        const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
        wrapper.find('.tool-call-log-wrapper').element.dispatchEvent(event);

        // Built-in log lines are read-only summaries, so the drag must not select them.
        expect(event.defaultPrevented).toBe(true);

        wrapper.unmount();
    });

    it('user can still select text in a generic tool row', async () => {
        const wrapper = mountItem({ source: 'mcp', status: 'completed' });

        const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
        wrapper.element.dispatchEvent(event);

        expect(event.defaultPrevented).toBe(false);

        wrapper.unmount();
    });
});
