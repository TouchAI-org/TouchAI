import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import type { SessionMessage, ToolCallInfo, WidgetInfo } from '@/types/session';
import AssistantMessage from '@/views/SearchView/components/ConversationPanel/components/AssistantMessage.vue';

/*
 * The existing AssistantMessage test covers reasoning blocks. This file covers the
 * rest of the message shell: the request-state line, the status line, the copy and
 * regenerate actions, the streaming indicator, and the parts that must not be shown
 * twice (a tool call backed by a widget, an approval with no matching record).
 */

const clipboardWriteTextMock = vi.hoisted(() => vi.fn());
const notifyMock = vi.hoisted(() => vi.fn());
const askUserStoreMock = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('@/stores/askUser', () => ({
    useAskUserStore: () => askUserStoreMock,
}));
vi.mock('@/services/NotificationService', () => ({ notify: notifyMock }));
vi.mock('@/services/ClipboardService', () => ({
    clipboardService: { writeText: clipboardWriteTextMock },
}));
vi.mock('@/components/MarkdownContent.vue', () => ({
    default: {
        props: ['content', 'final', 'variant'],
        template:
            '<div class="markdown" :data-final="String(final)" :data-variant="variant">{{ content }}</div>',
    },
}));
vi.mock('@/views/SearchView/components/ConversationPanel/components/ToolCallItem.vue', () => ({
    default: {
        props: ['toolCall'],
        template: '<div class="tool-call" :data-name="toolCall?.namespacedName" />',
    },
}));
vi.mock('@/views/SearchView/components/ConversationPanel/components/WidgetFrame.vue', () => ({
    default: {
        props: ['widget'],
        template: '<div class="widget" :data-id="widget?.widgetId" />',
    },
}));
vi.mock(
    '@/views/SearchView/components/ConversationPanel/components/ToolApprovalHistoryCard.vue',
    () => ({
        default: {
            props: ['approval'],
            template: '<div class="approval" :data-call="approval?.callId" />',
        },
    })
);

const wrappers: VueWrapper[] = [];

function render(message: Partial<SessionMessage>) {
    const wrapper = mount(AssistantMessage, {
        props: {
            message: {
                id: 'answer',
                role: 'assistant',
                content: 'The full answer',
                parts: [],
                timestamp: 1,
                ...message,
            },
        },
        global: {
            stubs: {
                AppIcon: { props: ['name'], template: '<svg :data-icon="name" />' },
                ActionButton: {
                    props: ['icon', 'handler', 'ariaLabel'],
                    template:
                        '<button :data-icon="icon" :aria-label="ariaLabel" @click="handler" />',
                },
            },
        },
    });
    wrappers.push(wrapper);
    return wrapper;
}

function actionButton(wrapper: ReturnType<typeof render>, icon: string) {
    return wrapper.findAll('button').find((button) => button.attributes('data-icon') === icon);
}

beforeEach(() => {
    vi.clearAllMocks();
    setLocale('zh-CN');
    askUserStoreMock.current = null;
    clipboardWriteTextMock.mockResolvedValue(undefined);
});

afterEach(() => {
    vi.useRealTimers();
    wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
});

describe('user reads why a request did not finish', () => {
    it('user sees the failure line instead of an empty answer', () => {
        const wrapper = render({
            content: 'The request failed',
            isError: true,
            parts: [{ id: 't1', type: 'text', content: 'partial' }],
        });

        expect(wrapper.text()).toContain('The request failed');
        expect(wrapper.find('.markdown').exists()).toBe(false);
    });

    it('user sees the cancellation line while a stopped answer is shown', () => {
        const wrapper = render({ content: 'Generation stopped', isCancelled: true });

        expect(wrapper.text()).toContain('Generation stopped');
    });

    it('user sees the retry line while a retry is running', () => {
        const wrapper = render({ content: 'Retrying', isRetrying: true });

        expect(wrapper.text()).toContain('Retrying');
    });

    it('user gets no copy or regenerate action for a failed request', () => {
        const wrapper = render({ isError: true });

        expect(actionButton(wrapper, 'copy')).toBeUndefined();
        expect(actionButton(wrapper, 'refresh')).toBeUndefined();
    });

    it('user sees the status text under a finished answer', () => {
        const wrapper = render({
            parts: [{ id: 't1', type: 'text', content: 'Done' }],
            statusText: 'Searched 3 pages',
        });

        expect(wrapper.text()).toContain('Searched 3 pages');
    });
});

describe('user acts on a finished answer', () => {
    it('user gets the copy action once the answer finishes', () => {
        const wrapper = render({ isStreaming: false });

        expect(actionButton(wrapper, 'copy')).toBeTruthy();
        expect(actionButton(wrapper, 'refresh')).toBeTruthy();
    });

    it('user gets no actions while the answer is still streaming', () => {
        const wrapper = render({ isStreaming: true });

        expect(actionButton(wrapper, 'copy')).toBeUndefined();
        expect(actionButton(wrapper, 'refresh')).toBeUndefined();
    });

    it('user gets the whole answer copied and told it worked', async () => {
        const wrapper = render({ isStreaming: false, content: 'The full answer' });

        await actionButton(wrapper, 'copy')!.trigger('click');

        expect(clipboardWriteTextMock).toHaveBeenCalledWith('The full answer');
        expect(notifyMock.mock.calls[0]?.[0]).toMatchObject({
            title: 'TouchAI',
            body: '已复制到剪贴板',
        });
    });

    it('user is told the copy failed when the clipboard rejects', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        clipboardWriteTextMock.mockRejectedValue(new Error('clipboard denied'));
        const wrapper = render({ isStreaming: false });

        await actionButton(wrapper, 'copy')!.trigger('click');

        const body = notifyMock.mock.calls[0]?.[0]?.body as string;
        expect(body).toBe('复制失败');
        expect(body).not.toBe('已复制到剪贴板');
        consoleError.mockRestore();
    });

    it('user gets the answer regenerated from the regenerate action', async () => {
        const wrapper = render({ id: 'answer-7', isStreaming: false });

        await actionButton(wrapper, 'refresh')!.trigger('click');

        expect(wrapper.emitted('regenerate')).toEqual([['answer-7']]);
    });
});

describe('user waits for a streaming answer', () => {
    it('user sees the typing indicator while the answer streams', () => {
        const wrapper = render({ isStreaming: true });

        expect(wrapper.find('.streaming-indicator').exists()).toBe(true);
    });

    it('user sees no typing indicator once the answer finishes', () => {
        const wrapper = render({ isStreaming: false });

        expect(wrapper.find('.streaming-indicator').exists()).toBe(false);
    });

    it('user sees no typing indicator while a question panel owns the turn', () => {
        askUserStoreMock.current = { question: 'Anything else?' };

        const wrapper = render({ isStreaming: true });

        expect(wrapper.find('.streaming-indicator').exists()).toBe(false);
    });

    it('user sees a rotating hint after a long wait, then it repeats', async () => {
        vi.useFakeTimers();
        const wrapper = render({ isStreaming: true });

        expect(wrapper.find('.loading-tip').exists()).toBe(false);

        await vi.advanceTimersByTimeAsync(20_000);
        const firstTip = wrapper.get('.loading-tip').text();
        expect(firstTip.length).toBeGreaterThan(0);

        await vi.advanceTimersByTimeAsync(5_000);
        expect(wrapper.get('.loading-tip').text()).not.toBe(firstTip);
    });

    it('user stops seeing the hint when the answer arrives', async () => {
        vi.useFakeTimers();
        const wrapper = render({ isStreaming: true });
        await vi.advanceTimersByTimeAsync(20_000);
        expect(wrapper.find('.loading-tip').exists()).toBe(true);

        await wrapper.setProps({ message: { ...wrapper.props('message'), isStreaming: false } });

        expect(wrapper.find('.loading-tip').exists()).toBe(false);
    });
});

function toolCall(id: string, namespacedName: string): ToolCallInfo {
    return {
        id,
        name: namespacedName.split('__').pop() ?? namespacedName,
        namespacedName,
        source: 'builtin',
        arguments: {},
        status: 'completed',
    };
}

function widget(callId: string): WidgetInfo {
    return {
        id: `widget-${callId}`,
        widgetId: `widget-${callId}`,
        callId,
        title: 'A widget',
        description: '',
        html: '<p>chart</p>',
        mode: 'render',
        phase: 'ready',
        updatedAt: 1,
    };
}

describe('user sees an answer whose parts are backed by richer records', () => {
    it('user sees a tool call inside the answer', () => {
        const wrapper = render({
            parts: [{ id: 'p1', type: 'tool_call', toolCall: toolCall('call-1', 'builtin__bash') }],
        });

        expect(wrapper.get('.tool-call').attributes('data-name')).toBe('builtin__bash');
    });

    it('user does not see the tool call behind a widget twice', () => {
        const wrapper = render({
            parts: [
                {
                    id: 'p1',
                    type: 'tool_call',
                    toolCall: toolCall('call-1', 'builtin__show_widget'),
                },
                { id: 'p2', type: 'widget', widgetId: 'widget-call-1' },
            ],
            widgets: [widget('call-1')],
        });

        expect(wrapper.find('.widget').exists()).toBe(true);
        expect(wrapper.find('.tool-call').exists()).toBe(false);
    });

    it('user sees an approval record attached to its call', () => {
        const wrapper = render({
            parts: [{ id: 'p1', type: 'approval', callId: 'call-9' }],
            approvals: [
                {
                    id: 'approval-9',
                    callId: 'call-9',
                    status: 'rejected',
                    title: 'Run a command',
                    description: '',
                    command: 'rm -rf build',
                    riskLabel: 'high',
                    reason: '',
                    commandLabel: 'Command',
                    approveLabel: 'Approve',
                    rejectLabel: 'Reject',
                    enterHint: '',
                    escHint: '',
                    keyboardApproveAt: 0,
                },
            ],
        });

        expect(wrapper.get('.approval').attributes('data-call')).toBe('call-9');
    });

    it('user sees no approval card when the record is missing', () => {
        const wrapper = render({
            parts: [{ id: 'p1', type: 'approval', callId: 'missing' }],
            approvals: [],
        });

        expect(wrapper.find('.approval').exists()).toBe(false);
    });

    it('user does not see an empty text part rendered as a blank block', () => {
        const wrapper = render({
            parts: [
                { id: 't1', type: 'text', content: '' },
                { id: 't2', type: 'text', content: 'Visible text' },
            ],
        });

        expect(wrapper.findAll('.markdown')).toHaveLength(1);
        expect(wrapper.get('.markdown').text()).toBe('Visible text');
    });

    it('user sees the answer marked final once streaming stops', () => {
        const wrapper = render({
            isStreaming: false,
            parts: [{ id: 't1', type: 'text', content: 'Finished' }],
        });

        expect(wrapper.get('.markdown').attributes('data-final')).toBe('true');
    });
});
