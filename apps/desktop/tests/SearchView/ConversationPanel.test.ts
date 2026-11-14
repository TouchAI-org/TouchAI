import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
            outputScrollBehavior: ref('follow_output'),
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
            },
            emits: ['update:modelValue', 'start'],
            template: '<div><slot /></div>',
        }),
    };
});

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
    it('user sees no faded placeholder while dragging a queued bubble', () => {
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

        expect(wrapper.findComponent({ name: 'VueDraggableStub' }).props('ghostClass')).toBe(
            'invisible'
        );
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
});
