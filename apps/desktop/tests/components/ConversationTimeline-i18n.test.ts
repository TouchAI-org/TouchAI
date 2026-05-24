import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import type { SessionMessage } from '@/types/session';
import ConversationTimeline from '@/views/SearchView/components/ConversationPanel/components/ConversationTimeline.vue';

function createUserMessage(id: string, content: string): SessionMessage {
    return {
        id,
        role: 'user',
        content,
        parts: [],
        timestamp: Date.now(),
    };
}

describe('ConversationTimeline i18n boundaries', () => {
    it('marks user-authored marker previews as not eligible for global DOM localization', () => {
        const wrapper = mount(ConversationTimeline, {
            props: {
                messages: [
                    createUserMessage('user-1', '设置'),
                    createUserMessage('user-2', '继续'),
                ],
                containerHeight: 240,
                scrollTop: 0,
                scrollHeight: 480,
                clientHeight: 240,
            },
        });

        const marker = wrapper.get('.timeline-marker');
        expect(marker.attributes('title')).toBe('设置');
        expect(marker.attributes('aria-label')).toContain('设置');
        expect(marker.attributes('data-no-i18n')).toBe('true');
        expect(marker.attributes('translate')).toBe('no');

        const tooltip = marker.get('.marker-tooltip');
        expect(tooltip.text()).toBe('设置');
        expect(tooltip.attributes('data-no-i18n')).toBe('true');
        expect(tooltip.attributes('translate')).toBe('no');
    });
});
