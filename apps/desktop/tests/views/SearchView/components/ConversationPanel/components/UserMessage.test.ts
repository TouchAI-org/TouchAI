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
