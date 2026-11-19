import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

const scrollSettings = vi.hoisted(() => ({ outputScrollBehavior: 'follow_output' }));

beforeEach(() => {
    scrollSettings.outputScrollBehavior = 'follow_output';
});

vi.mock('@components/AppIcon.vue', () => ({
    default: { props: ['name'], template: '<span />' },
}));

vi.mock('@composables/useScrollbarStabilizer', () => ({
    useScrollbarStabilizer: vi.fn(),
}));

vi.mock('@/stores/settings', async () => {
    const { ref } = await import('vue');
    return {
        useSettingsStore: () => ({
            outputScrollBehavior: ref(scrollSettings.outputScrollBehavior),
            initialize: vi.fn().mockResolvedValue(undefined),
        }),
    };
});

vi.mock(
    '@/views/SearchView/components/ConversationPanel/components/ConversationToolbar.vue',
    () => ({
        default: {
            props: [
                'isPinned',
                'isMaximized',
                'canPin',
                'disabled',
                'historyOpen',
                'startDragging',
            ],
            template: '<div data-toolbar />',
        },
    })
);

vi.mock(
    '@/views/SearchView/components/ConversationPanel/components/ConversationTimeline.vue',
    () => ({
        default: { props: ['messages'], template: '<div data-timeline />' },
    })
);

vi.mock('@/views/SearchView/components/ConversationPanel/components/MessageItem.vue', () => ({
    default: { props: ['message'], template: '<div data-message />' },
}));

vi.mock('vue-draggable-plus', async () => {
    const { defineComponent } = await import('vue');
    return {
        VueDraggable: defineComponent({
            name: 'VueDraggableStub',
            props: {
                modelValue: {
                    type: Array,
                    default: () => [],
                },
                ghostClass: {
                    type: String,
                    default: '',
                },
                fallbackClass: {
                    type: String,
                    default: '',
                },
            },
            emits: ['update:modelValue', 'start'],
            template: '<div><slot /></div>',
        }),
    };
});

import type { SessionMessage } from '@/app/api/agent/history';
import MessageScroller from '@/components/ui/message-scroller/MessageScroller.vue';
import ConversationPanel from '@/views/SearchView/components/ConversationPanel/index.vue';

describe('ConversationPanel intrinsic session measurement', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal(
            'ResizeObserver',
            class {
                observe() {}
                disconnect() {}
            }
        );
    });

    it('user opens a session with the conversation viewport bounded during measurement', () => {
        const wrapper = mount(ConversationPanel, {
            props: {
                startDragging: vi.fn().mockResolvedValue(undefined),
                messages: [],
                isLoading: false,
                error: null,
                isPinned: false,
                historyOpen: false,
            },
        });

        expect(wrapper.get('[data-slot="message-scroller"]').classes()).toContain('h-full');
        expect(wrapper.get('[data-slot="message-scroller"] section').classes()).toContain('h-full');
        wrapper.unmount();
    });
});

describe('ConversationPanel queued message reordering', () => {
    it('user adds a priority message ahead of an existing queue and jumps to the new message', async () => {
        scrollSettings.outputScrollBehavior = 'jump_to_top';
        const bounds = vi
            .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
            .mockImplementation(function (this: HTMLElement) {
                const messageId = this.getAttribute('data-message-id');
                const top = messageId === 'priority-1' ? 300 : messageId === 'queue-1' ? 600 : 0;
                return new DOMRect(0, top, 200, 100);
            });
        const queueMessage = {
            id: 'queue-1',
            prompt: 'already queued',
            attachments: [],
            delivery: 'queue' as const,
            createdAt: 3,
        };
        const wrapper = mount(ConversationPanel, {
            props: {
                startDragging: vi.fn().mockResolvedValue(undefined),
                messages: [
                    { id: 'user-1', role: 'user', content: 'prompt', parts: [], timestamp: 1 },
                    {
                        id: 'assistant-1',
                        role: 'assistant',
                        content: 'answer',
                        parts: [],
                        timestamp: 2,
                    },
                ],
                pendingMessages: [queueMessage],
                isLoading: true,
                error: null,
                isPinned: false,
                historyOpen: false,
            },
        });
        const viewport = wrapper.get('section').element as HTMLElement;
        Object.defineProperties(viewport, {
            scrollHeight: { configurable: true, value: 1_000 },
            clientHeight: { configurable: true, value: 400 },
            scrollTo: {
                configurable: true,
                value: ({ top }: ScrollToOptions) => {
                    viewport.scrollTop = top ?? 0;
                },
            },
        });

        try {
            await flushPromises();
            await wrapper.setProps({
                pendingMessages: [
                    queueMessage,
                    {
                        ...queueMessage,
                        id: 'priority-1',
                        prompt: 'new steer',
                        delivery: 'priority',
                    },
                ],
            });
            await flushPromises();

            expect(viewport.scrollTop).toBe(288);
        } finally {
            wrapper.unmount();
            bounds.mockRestore();
        }
    });

    it('user sees the pointer ghost but no drop-position ghost while dragging a queued bubble', () => {
        const wrapper = mount(ConversationPanel, {
            props: {
                startDragging: vi.fn().mockResolvedValue(undefined),
                messages: [],
                pendingMessages: [
                    {
                        id: 'queue-1',
                        prompt: 'first queued',
                        attachments: [],
                        delivery: 'queue',
                        createdAt: 1,
                    },
                    {
                        id: 'queue-2',
                        prompt: 'second queued',
                        attachments: [],
                        delivery: 'queue',
                        createdAt: 2,
                    },
                ],
                isLoading: false,
                error: null,
                isPinned: false,
                historyOpen: false,
            },
        });

        const draggable = wrapper.findComponent({ name: 'VueDraggableStub' });
        expect(draggable.props('ghostClass')).toBe('invisible');
        expect(draggable.props('fallbackClass')).not.toBe('invisible');
        wrapper.unmount();
    });

    it('user keeps the queued order stable while only the streamed reply grows', async () => {
        const pendingMessages = [
            {
                id: 'queue-1',
                prompt: 'first queued',
                attachments: [],
                delivery: 'queue' as const,
                createdAt: 1,
            },
        ];
        const wrapper = mount(ConversationPanel, {
            props: {
                startDragging: vi.fn().mockResolvedValue(undefined),
                messages: [
                    {
                        id: 'assistant-1',
                        role: 'assistant',
                        content: 'streamed',
                        parts: [],
                        timestamp: 1,
                        isStreaming: true,
                    },
                ],
                pendingMessages,
                isLoading: true,
                error: null,
                isPinned: false,
                historyOpen: false,
            },
        });
        const draggable = wrapper.findComponent({ name: 'VueDraggableStub' });
        const initialQueue = draggable.props('modelValue');

        await wrapper.setProps({
            messages: [
                {
                    id: 'assistant-1',
                    role: 'assistant',
                    content: 'streamed with another wrapped line',
                    parts: [],
                    timestamp: 1,
                    isStreaming: true,
                },
            ],
        });

        expect(draggable.props('modelValue')).toBe(initialQueue);
        wrapper.unmount();
    });

    it('user gets the new queue order emitted when a queued bubble is dragged', async () => {
        const wrapper = mount(ConversationPanel, {
            props: {
                startDragging: vi.fn().mockResolvedValue(undefined),
                messages: [],
                pendingMessages: [
                    {
                        id: 'queue-1',
                        prompt: 'first queued',
                        attachments: [],
                        delivery: 'queue',
                        createdAt: 1,
                    },
                    {
                        id: 'queue-2',
                        prompt: 'second queued',
                        attachments: [],
                        delivery: 'queue',
                        createdAt: 2,
                    },
                ],
                isLoading: false,
                error: null,
                isPinned: false,
                historyOpen: false,
            },
        });

        wrapper
            .findComponent({ name: 'VueDraggableStub' })
            .vm.$emit('update:modelValue', [{ id: 'queue-2' }, { id: 'queue-1' }]);
        await wrapper.vm.$nextTick();

        expect(wrapper.emitted('reorderPendingMessages')).toEqual([[['queue-2', 'queue-1']]]);
        wrapper.unmount();
    });

    it('user does not see queued bubbles as conversation navigation turns', () => {
        const wrapper = mount(ConversationPanel, {
            props: {
                startDragging: vi.fn().mockResolvedValue(undefined),
                messages: [
                    {
                        id: 'user-1',
                        role: 'user',
                        content: 'prompt',
                        parts: [],
                        timestamp: 1,
                    },
                    {
                        id: 'assistant-1',
                        role: 'assistant',
                        content: 'answer',
                        parts: [],
                        timestamp: 2,
                    },
                ],
                pendingMessages: [
                    {
                        id: 'queue-1',
                        prompt: 'queued',
                        attachments: [],
                        delivery: 'queue',
                        createdAt: 3,
                    },
                ],
                isLoading: true,
                error: null,
                isPinned: false,
                historyOpen: false,
            },
        });

        const items = wrapper.findComponent(MessageScroller).props('items') as Array<{
            id: string;
        }>;
        expect(items.map((item) => item.id)).toEqual(['user-1']);
        wrapper.unmount();
    });

    it('user keeps the compaction announcement while a queued bubble exists', async () => {
        const message: SessionMessage = {
            id: 'assistant-1',
            role: 'assistant' as const,
            content: '',
            parts: [{ id: 'compact-1', type: 'context_compaction' as const, state: 'compacting' }],
            timestamp: 2,
            isStreaming: true,
        };
        const wrapper = mount(ConversationPanel, {
            props: {
                startDragging: vi.fn().mockResolvedValue(undefined),
                messages: [
                    {
                        id: 'user-1',
                        role: 'user',
                        content: 'prompt',
                        parts: [],
                        timestamp: 1,
                    },
                    message,
                ],
                pendingMessages: [],
                isLoading: true,
                error: null,
                isPinned: false,
                historyOpen: false,
            },
        });

        await nextTick();
        expect(wrapper.get('[role="status"]').text()).toContain('正在压缩上下文');

        await wrapper.setProps({
            pendingMessages: [
                {
                    id: 'queue-1',
                    prompt: 'queued',
                    attachments: [],
                    delivery: 'queue',
                    createdAt: 3,
                },
            ],
        });

        expect(wrapper.get('[role="status"]').text()).toContain('正在压缩上下文');
        wrapper.unmount();
    });
});
