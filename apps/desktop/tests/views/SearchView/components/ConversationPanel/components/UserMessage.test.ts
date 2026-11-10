import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';

import type { SessionMessage } from '@/types/session';
import UserMessage from '@/views/SearchView/components/ConversationPanel/components/UserMessage.vue';

vi.mock('@services/NotificationService', () => ({ notify: vi.fn() }));
vi.mock('@/services/ClipboardService', () => ({ clipboardService: { writeText: vi.fn() } }));

function createImageMessage() {
    return {
        id: 'user-1',
        role: 'user' as const,
        content: '',
        parts: [],
        timestamp: 1,
        attachments: [
            {
                type: 'image',
                name: 'photo.png',
                preview: 'data:image/png;base64,AAAA',
            },
        ],
    };
}

describe('UserMessage attachment images', () => {
    it('user keeps the source image while offscreen decoding is deferred', async () => {
        const wrapper = mount(UserMessage, {
            props: {
                message: createImageMessage() as unknown as SessionMessage,
            },
        });

        const image = wrapper.find('.image-attachment img');
        expect(image.exists()).toBe(true);
        expect(image.attributes('decoding')).toBe('async');
        expect(image.attributes('loading')).toBe('lazy');
        expect(image.attributes('src')).toBe(createImageMessage().attachments[0]?.preview);
        const preview = 'data:image/gif;base64,BBBB';
        await wrapper.setProps({
            message: {
                ...createImageMessage(),
                attachments: [{ type: 'image', name: 'animation.gif', preview }],
            } as unknown as SessionMessage,
        });
        expect(image.attributes('src')).toBe(preview);

        wrapper.unmount();
    });
});

describe('UserMessage pending delivery', () => {
    it('user sees a queued message as a dashed bubble with muted text', () => {
        const wrapper = mount(UserMessage, {
            props: {
                message: {
                    id: 'pending-1',
                    role: 'user',
                    content: 'queued text',
                    parts: [],
                    timestamp: 1,
                    pendingDelivery: 'queue',
                } as SessionMessage,
            },
        });

        const bubble = wrapper.get('[data-pending-delivery="queue"]');
        expect(bubble.classes()).toContain('border-dashed');
        expect(bubble.classes()).toContain('bg-transparent');
        expect(wrapper.get('.user-text').classes()).toContain('text-text-tertiary');
        expect(wrapper.findComponent({ name: 'ActionButton' }).exists()).toBe(false);

        wrapper.unmount();
    });

    it('user sees a delivered message as the normal solid bubble', () => {
        const wrapper = mount(UserMessage, {
            props: {
                message: {
                    id: 'user-1',
                    role: 'user',
                    content: 'delivered text',
                    parts: [],
                    timestamp: 1,
                } as SessionMessage,
            },
        });

        expect(wrapper.find('[data-pending-delivery]').exists()).toBe(false);
        expect(wrapper.get('.rounded-lg').classes()).toContain('bg-muted');
        expect(wrapper.get('.user-text').classes()).toContain('text-foreground');

        wrapper.unmount();
    });
});
