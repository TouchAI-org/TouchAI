import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionMessage } from '@/types/session';
import AssistantMessage from '@/views/SearchView/components/ConversationPanel/components/AssistantMessage.vue';

vi.mock('@/stores/askUser', () => ({ useAskUserStore: () => ({ current: null }) }));
vi.mock('@/services/NotificationService', () => ({ notify: vi.fn() }));
vi.mock('@/services/ClipboardService', () => ({ clipboardService: { writeText: vi.fn() } }));
vi.mock('@/components/MarkdownContent.vue', () => ({
    default: {
        props: ['content', 'final', 'variant'],
        template: '<div class="markdown">{{ content }}</div>',
    },
}));
vi.mock('@/views/SearchView/components/ConversationPanel/components/ToolCallItem.vue', () => ({
    default: { template: '<div>Tool</div>' },
}));
vi.mock('@/views/SearchView/components/ConversationPanel/components/WidgetFrame.vue', () => ({
    default: { props: ['widget'], template: '<div data-widget>{{ widget.html }}</div>' },
}));
vi.mock(
    '@/views/SearchView/components/ConversationPanel/components/ToolApprovalHistoryCard.vue',
    () => ({ default: { template: '<div>Approval</div>' } })
);

const wrappers: VueWrapper[] = [];

function render(message: Partial<SessionMessage>) {
    const wrapper = mount(AssistantMessage, {
        props: {
            message: {
                id: 'answer',
                role: 'assistant',
                content: '',
                parts: [],
                timestamp: 1,
                ...message,
            },
        },
        global: {
            stubs: {
                AppIcon: { props: ['name'], template: '<svg :data-icon="name" />' },
                ActionButton: true,
                MotionCollapse: { props: ['open'], template: '<div><slot /></div>' },
            },
        },
    });

    wrappers.push(wrapper);
    return wrapper;
}

function setVisibility(state: 'visible' | 'hidden') {
    Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => state,
    });
    document.dispatchEvent(new Event('visibilitychange'));
}

describe('when the window is hidden while an answer streams', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        while (wrappers.length > 0) {
            wrappers.pop()?.unmount();
        }
        setVisibility('visible');
    });

    it('user gets the listener removed when the message unmounts', () => {
        const removeSpy = vi.spyOn(document, 'removeEventListener');
        const wrapper = render({ isStreaming: true });

        wrapper.unmount();
        wrappers.pop();

        expect(removeSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
        removeSpy.mockRestore();
    });

    it('user sees the streaming tips stop while the window is in the background', () => {
        render({ isStreaming: true });

        setVisibility('hidden');

        expect(vi.getTimerCount()).toBe(0);
    });

    it('user sees the tips resume once the window is visible again', () => {
        render({ isStreaming: true });

        setVisibility('hidden');
        setVisibility('visible');

        expect(vi.getTimerCount()).toBeGreaterThan(0);
    });

    it('user gets no tip timers for a finished answer', () => {
        render({ isStreaming: false });

        setVisibility('visible');

        expect(vi.getTimerCount()).toBe(0);
    });
});

describe('when a widget part still carries the tool call id', () => {
    it('user still sees the widget while the draft is being retargeted', () => {
        const wrapper = render({
            parts: [{ id: 'p1', type: 'widget', widgetId: 'call-1' } as never],
            widgets: [
                {
                    id: 'algo-anim',
                    widgetId: 'algo-anim',
                    callId: 'call-1',
                    title: 'algo',
                    description: '',
                    html: '<div>chart</div>',
                    mode: 'render',
                    phase: 'draft',
                    updatedAt: 1,
                } as never,
            ],
        });

        expect(wrapper.html()).toContain('chart');
    });
});
