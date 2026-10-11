import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

import { setLocale } from '@/i18n';
import type { SessionMessage } from '@/types/session';
import AssistantMessage from '@/views/SearchView/components/ConversationPanel/components/AssistantMessage.vue';

vi.mock('@/stores/askUser', () => ({ useAskUserStore: () => ({ current: null }) }));
vi.mock('@/services/NotificationService', () => ({ notify: vi.fn() }));
vi.mock('@/services/ClipboardService', () => ({ clipboardService: { writeText: vi.fn() } }));
vi.mock('@/components/MarkdownContent.vue', () => ({
    default: {
        props: ['content', 'final', 'variant'],
        template: '<div class="markdown" :data-final="final">{{ content }}</div>',
    },
}));
vi.mock('@/views/SearchView/components/ConversationPanel/components/ToolCallItem.vue', () => ({
    default: { template: '<div>Tool</div>' },
}));
vi.mock('@/views/SearchView/components/ConversationPanel/components/WidgetFrame.vue', () => ({
    default: { template: '<div>Widget</div>' },
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
            },
        },
    });
    wrappers.push(wrapper);
    return wrapper;
}

beforeEach(() => {
    setLocale('zh-CN');
});
afterEach(() => {
    wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
});

describe('AssistantMessage interleaved reasoning', () => {
    it('renders reasoning in timeline order without duplicating the aggregate field', async () => {
        const wrapper = render({
            content: 'First answer',
            reasoning: 'First thoughtSecond thought',
            isStreaming: true,
            parts: [
                { id: 'r1', type: 'reasoning', content: 'First thought', isStreaming: false },
                { id: 't1', type: 'text', content: 'First answer' },
                { id: 'r2', type: 'reasoning', content: 'Second thought', isStreaming: true },
            ],
        });
        expect(wrapper.findAll('.markdown').map((node) => node.text())).toEqual([
            'First thought',
            'First answer',
            'Second thought',
        ]);
        const sections = wrapper.findAll('.reasoning-section');
        expect(sections).toHaveLength(2);
        expect(sections[0]!.find('.reasoning-shimmer').exists()).toBe(false);
        expect(sections[1]!.find('.reasoning-shimmer').exists()).toBe(true);
        expect(wrapper.find('.reasoning-sparkle').exists()).toBe(false);
        expect(sections[0]!.find('[data-icon="chevron-right"]').exists()).toBe(true);
        expect(sections[1]!.find('[data-icon="chevron-down"]').exists()).toBe(true);
        expect(sections[0]!.find('button').attributes('aria-expanded')).toBe('false');
        expect(sections[0]!.find('.reasoning-label-content').text()).toBe('已思考');
        expect(sections[1]!.find('button').attributes('aria-expanded')).toBe('true');
        expect(sections[1]!.find('.reasoning-label-content').text()).toBe('思考中 （1s）');
        await sections[0]!.find('button').trigger('click');
        expect(sections[0]!.find('button').attributes('aria-expanded')).toBe('true');
        expect(sections[0]!.find('[data-icon="chevron-down"]').exists()).toBe(true);
        expect(sections[1]!.find('button').attributes('aria-expanded')).toBe('true');
        expect(sections[1]!.find('.reasoning-label-content').text()).toBe('思考中 （1s）');
        await wrapper.setProps({ message: { ...wrapper.props('message'), isStreaming: false } });
        expect(wrapper.find('.reasoning-shimmer').exists()).toBe(false);
        expect(sections[1]!.find('button').attributes('aria-expanded')).toBe('false');
        expect(sections[1]!.find('[data-icon="chevron-right"]').exists()).toBe(true);
        expect(sections[1]!.find('.markdown').attributes('data-final')).toBe('true');
    });

    it('keeps legacy aggregate-only reasoning visible once', () => {
        const wrapper = render({
            reasoning: 'Legacy thought',
            content: 'Answer',
            parts: [{ id: 't1', type: 'text', content: 'Answer' }],
        });
        expect(wrapper.findAll('.reasoning-section')).toHaveLength(1);
        expect(wrapper.findAll('.markdown').map((node) => node.text())).toEqual([
            'Legacy thought',
            'Answer',
        ]);
    });

    it('stops shimmer at the reasoning end, even while the message is streaming', async () => {
        const wrapper = render({
            isStreaming: true,
            parts: [{ id: 'r1', type: 'reasoning', content: 'Thought', isStreaming: true }],
        });
        expect(wrapper.find('.reasoning-shimmer').exists()).toBe(true);
        await wrapper.setProps({
            message: {
                ...wrapper.props('message'),
                parts: [{ id: 'r1', type: 'reasoning', content: 'Thought', isStreaming: false }],
            },
        });
        expect(wrapper.find('.reasoning-shimmer').exists()).toBe(false);
        expect(wrapper.find('.reasoning-section .reasoning-label-content').text()).toBe('已思考');
    });

    it('updates the in-progress elapsed seconds and shows the final duration', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(1_000));
        const wrapper = render({
            isStreaming: true,
            parts: [
                {
                    id: 'r1',
                    type: 'reasoning',
                    content: 'Thought',
                    isStreaming: true,
                    startedAt: 1_000,
                },
            ],
        });
        expect(wrapper.find('.reasoning-section .reasoning-label-content').text()).toBe(
            '思考中 （1s）'
        );
        await vi.advanceTimersByTimeAsync(1_000);
        expect(wrapper.find('.reasoning-section .reasoning-label-content').text()).toBe(
            '思考中 （1s）'
        );
        await vi.advanceTimersByTimeAsync(1_000);
        expect(wrapper.find('.reasoning-section .reasoning-label-content').text()).toBe(
            '思考中 （2s）'
        );

        await wrapper.setProps({
            message: {
                ...wrapper.props('message'),
                isStreaming: false,
                parts: [
                    {
                        id: 'r1',
                        type: 'reasoning',
                        content: 'Thought',
                        isStreaming: false,
                        startedAt: 1_000,
                        endedAt: 3_400,
                    },
                ],
            },
        });
        expect(wrapper.find('.reasoning-section .reasoning-label-content').text()).toBe(
            '已思考 （2s）'
        );
    });
    it('does not invent a duration when a completed part only has a start timestamp', () => {
        const wrapper = render({
            isStreaming: false,
            parts: [
                {
                    id: 'r1',
                    type: 'reasoning',
                    content: 'Thought',
                    isStreaming: false,
                    startedAt: 1_000,
                },
            ],
        });

        expect(wrapper.find('.reasoning-section .reasoning-label-content').text()).toBe('已思考');
    });

    it('opens a completed reasoning block at the bottom when it has not been manually scrolled', async () => {
        const wrapper = render({
            isStreaming: false,
            parts: [{ id: 'r1', type: 'reasoning', content: 'Thought', isStreaming: false }],
        });
        const section = wrapper.find('.reasoning-section');
        const content = section.find('.reasoning-content').element as HTMLElement;
        let scrollTop = 0;
        Object.defineProperties(content, {
            clientHeight: { configurable: true, value: 160 },
            scrollHeight: { configurable: true, value: 640 },
            scrollTop: {
                configurable: true,
                get: () => scrollTop,
                set: (value: number) => {
                    scrollTop = value;
                },
            },
        });

        await section.find('button').trigger('click');
        await nextTick();

        expect(scrollTop).toBe(480);
    });

    it('stops following a completed reasoning block after a manual upward scroll', async () => {
        const wrapper = render({
            isStreaming: false,
            parts: [{ id: 'r1', type: 'reasoning', content: 'Thought', isStreaming: false }],
        });
        const section = wrapper.find('.reasoning-section');
        const content = section.find('.reasoning-content').element as HTMLElement;
        let scrollTop = 0;
        let scrollHeight = 640;
        Object.defineProperties(content, {
            clientHeight: { configurable: true, value: 160 },
            scrollHeight: {
                configurable: true,
                get: () => scrollHeight,
            },
            scrollTop: {
                configurable: true,
                get: () => scrollTop,
                set: (value: number) => {
                    scrollTop = value;
                },
            },
        });

        await section.find('button').trigger('click');
        await nextTick();
        expect(scrollTop).toBe(480);

        scrollTop = 120;
        await section.find('.reasoning-content').trigger('scroll');
        scrollHeight = 800;
        await wrapper.setProps({
            message: {
                ...wrapper.props('message'),
                parts: [
                    { id: 'r1', type: 'reasoning', content: 'Longer thought', isStreaming: false },
                ],
            },
        });
        await nextTick();

        expect(scrollTop).toBe(120);
    });
    it('does not treat collapsing an unopened block as a manual scroll', async () => {
        const wrapper = render({
            isStreaming: false,
            parts: [{ id: 'r1', type: 'reasoning', content: 'Thought', isStreaming: false }],
        });
        const section = wrapper.find('.reasoning-section');
        const content = section.find('.reasoning-content').element as HTMLElement;
        let scrollTop = 0;
        let clientHeight = 160;
        Object.defineProperties(content, {
            clientHeight: {
                configurable: true,
                get: () => clientHeight,
            },
            scrollHeight: { configurable: true, value: 640 },
            scrollTop: {
                configurable: true,
                get: () => scrollTop,
                set: (value: number) => {
                    scrollTop = value;
                },
            },
        });

        await section.find('button').trigger('click');
        await nextTick();
        expect(scrollTop).toBe(480);

        await section.find('button').trigger('click');
        clientHeight = 0;
        scrollTop = 0;
        await section.find('.reasoning-content').trigger('scroll');

        clientHeight = 160;
        await section.find('button').trigger('click');
        await nextTick();

        expect(scrollTop).toBe(480);
    });
    it('localizes thinking labels and gives each disclosure a unique target', () => {
        setLocale('en-US');
        const wrapper = render({
            isStreaming: true,
            parts: [
                { id: 'r1', type: 'reasoning', content: 'One', isStreaming: false },
                { id: 'r2', type: 'reasoning', content: 'Two', isStreaming: true },
            ],
        });
        const buttons = wrapper.findAll('.reasoning-section button');
        expect(buttons[0]!.find('.reasoning-label-content').text()).toBe('Thought');
        expect(buttons[1]!.find('.reasoning-label-content').text()).toBe('Thinking (1s)');
        expect(buttons[0]!.attributes('aria-controls')).not.toBe(
            buttons[1]!.attributes('aria-controls')
        );
        for (const button of buttons)
            expect(wrapper.find(`#${button.attributes('aria-controls')}`).exists()).toBe(true);
    });
});
