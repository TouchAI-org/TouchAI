import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';

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
    it('decodes off the main thread and defers offscreen images', () => {
        const wrapper = mount(UserMessage, {
            props: {
                message: createImageMessage() as Parameters<typeof UserMessage>[0]['message'],
            },
        });

        const image = wrapper.find('.image-attachment img');
        expect(image.exists()).toBe(true);
        expect(image.attributes('decoding')).toBe('async');
        expect(image.attributes('loading')).toBe('lazy');

        wrapper.unmount();
    });

    it('falls back to the original preview when thumbnail generation is unavailable', async () => {
        const preview = 'data:image/png;base64,AAAA';
        const wrapper = mount(UserMessage, {
            props: {
                message: {
                    ...createImageMessage(),
                    attachments: [{ type: 'image', name: 'photo.png', preview }],
                } as Parameters<typeof UserMessage>[0]['message'],
            },
        });

        const image = wrapper.find('.image-attachment img');
        expect(image.attributes('src')).toBe(preview);

        wrapper.unmount();
    });
});
