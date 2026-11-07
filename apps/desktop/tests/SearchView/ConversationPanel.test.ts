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
