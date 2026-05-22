import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionMessage } from '@/types/session';
import { getSessionStatusReminderContent } from '@/utils/session';
import ConversationPanel from '@/views/SearchView/components/ConversationPanel/index.vue';

const settingsStoreMock = vi.hoisted(() => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    outputScrollBehavior: 'follow_output',
}));

vi.mock('pinia', () => ({
    storeToRefs: (store: { outputScrollBehavior: string }) => ({
        outputScrollBehavior: { value: store.outputScrollBehavior },
    }),
}));

vi.mock('@/stores/settings', () => ({
    useSettingsStore: () => settingsStoreMock,
}));

vi.mock('@composables/useScrollbarStabilizer', () => ({
    useScrollbarStabilizer: vi.fn(),
}));

class ResizeObserverMock {
    observe() {}

    disconnect() {}
}

describe('ConversationPanel', () => {
    beforeEach(() => {
        vi.stubGlobal('ResizeObserver', ResizeObserverMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('filters persistent session status reminder messages from the conversation list', () => {
        const messages: SessionMessage[] = [
            {
                id: 'status-1',
                role: 'system',
                content: getSessionStatusReminderContent('completed'),
                parts: [],
                timestamp: 1,
            },
            {
                id: 'assistant-1',
                role: 'assistant',
                content: '正常回复内容',
                parts: [],
                timestamp: 2,
            },
        ];

        const wrapper = mount(ConversationPanel, {
            props: {
                messages,
                isLoading: false,
                error: null,
                isPinned: false,
                historyOpen: false,
            },
            global: {
                stubs: {
                    AppIcon: {
                        template: '<span data-testid="icon" />',
                    },
                    ConversationToolbar: {
                        template: '<div data-testid="toolbar" />',
                    },
                    ConversationTimeline: {
                        template: '<div data-testid="timeline" />',
                    },
                    MessageItem: {
                        props: ['message'],
                        template: '<div class="message-item">{{ message.content }}</div>',
                    },
                },
            },
        });

        const messageItems = wrapper.findAll('.message-item');
        expect(messageItems).toHaveLength(1);
        expect(messageItems[0]?.text()).toBe('正常回复内容');
        expect(wrapper.text()).not.toContain(getSessionStatusReminderContent('completed'));
        wrapper.unmount();
    });

    it('renders the transient overlay content when provided', () => {
        const wrapper = mount(ConversationPanel, {
            props: {
                messages: [],
                isLoading: false,
                error: null,
                isPinned: false,
                historyOpen: false,
                statusReminderOverlay: {
                    id: 1,
                    kind: 'completed',
                    content: getSessionStatusReminderContent('completed'),
                },
            },
            global: {
                stubs: {
                    AppIcon: {
                        template: '<span data-testid="icon" />',
                    },
                    ConversationToolbar: {
                        template: '<div data-testid="toolbar" />',
                    },
                    ConversationTimeline: {
                        template: '<div data-testid="timeline" />',
                    },
                    MessageItem: {
                        props: ['message'],
                        template: '<div class="message-item">{{ message.content }}</div>',
                    },
                },
            },
        });

        const overlay = wrapper.find('.status-reminder-overlay');
        expect(overlay.exists()).toBe(true);
        expect(overlay.text()).toContain(getSessionStatusReminderContent('completed'));
        wrapper.unmount();
    });
});
