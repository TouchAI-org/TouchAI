import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';

import type { SessionMessage } from '@/types/session';
import UserMessage from '@/views/SearchView/components/ConversationPanel/components/UserMessage.vue';

vi.mock('@services/NotificationService', () => ({ notify: vi.fn() }));
vi.mock('@/services/ClipboardService', () => ({ clipboardService: { writeText: vi.fn() } }));
vi.mock('@components/AppIcon.vue', () => ({
    default: {
        name: 'AppIconStub',
        props: ['name'],
        template: '<span data-testid="app-icon" :data-name="name" />',
    },
}));

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

describe('UserMessage long content', () => {
    it('user collapses a long message to six lines and can expand it again', async () => {
        const content = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join('\n');
        const wrapper = mount(UserMessage, {
            props: {
                message: {
                    id: 'user-long',
                    role: 'user',
                    content,
                    parts: [],
                    timestamp: 1,
                } as SessionMessage,
            },
        });

        const text = wrapper.get('.user-text');
        expect(text.classes()).toContain('line-clamp-6');
        expect(text.attributes('data-collapsed')).toBe('true');

        const toggle = wrapper.get('[data-testid="user-message-expand-toggle"]');
        expect(toggle.text()).toContain('展开全文');
        expect(toggle.attributes('aria-expanded')).toBe('false');

        await toggle.trigger('click');

        expect(wrapper.get('.user-text').classes()).not.toContain('line-clamp-6');
        expect(wrapper.get('[data-testid="user-message-expand-toggle"]').text()).toContain('收起');
        expect(
            wrapper
                .get('[data-testid="user-message-expand-toggle"] [data-testid="app-icon"]')
                .attributes('data-name')
        ).toBe('chevron-up');
        expect(
            wrapper.get('[data-testid="user-message-expand-toggle"]').attributes('aria-expanded')
        ).toBe('true');

        await wrapper.get('[data-testid="user-message-expand-toggle"]').trigger('click');
        expect(wrapper.get('.user-text').classes()).toContain('line-clamp-6');
        expect(
            wrapper
                .get('[data-testid="user-message-expand-toggle"] [data-testid="app-icon"]')
                .attributes('data-name')
        ).toBe('chevron-down');

        wrapper.unmount();
    });

    it('user sees no expand control on a short message', () => {
        const wrapper = mount(UserMessage, {
            props: {
                message: {
                    id: 'user-short',
                    role: 'user',
                    content: 'short text',
                    parts: [],
                    timestamp: 1,
                } as SessionMessage,
            },
        });

        expect(wrapper.find('[data-testid="user-message-expand-toggle"]').exists()).toBe(false);

        wrapper.unmount();
    });

    it('user gets the expand control when the rendered bubble overflows', async () => {
        const wrapper = mount(UserMessage, {
            props: {
                message: {
                    id: 'user-measured',
                    role: 'user',
                    content: 'short text',
                    parts: [],
                    timestamp: 1,
                } as SessionMessage,
            },
        });
        const text = wrapper.get('.user-text').element;
        Object.defineProperty(text, 'clientHeight', { configurable: true, value: 96 });
        Object.defineProperty(text, 'scrollHeight', { configurable: true, value: 240 });

        window.dispatchEvent(new Event('resize'));
        await wrapper.vm.$nextTick();

        expect(wrapper.find('[data-testid="user-message-expand-toggle"]').exists()).toBe(true);

        Object.defineProperty(text, 'scrollHeight', { configurable: true, value: 97 });
        window.dispatchEvent(new Event('resize'));
        await wrapper.vm.$nextTick();

        expect(wrapper.find('[data-testid="user-message-expand-toggle"]').exists()).toBe(false);

        wrapper.unmount();
    });

    it('user gets a changed message measured and reset to its collapsed state', async () => {
        const wrapper = mount(UserMessage, {
            props: {
                message: {
                    id: 'user-first',
                    role: 'user',
                    content: Array.from({ length: 10 }, (_, index) => `line ${index}`).join('\n'),
                    parts: [],
                    timestamp: 1,
                } as SessionMessage,
            },
        });
        await wrapper.get('[data-testid="user-message-expand-toggle"]').trigger('click');
        expect(
            wrapper.get('[data-testid="user-message-expand-toggle"]').attributes('aria-expanded')
        ).toBe('true');

        await wrapper.setProps({
            message: {
                id: 'user-second',
                role: 'user',
                content: Array.from({ length: 10 }, (_, index) => `next ${index}`).join('\n'),
                parts: [],
                timestamp: 1,
            } as SessionMessage,
        });
        await wrapper.vm.$nextTick();

        expect(wrapper.get('.user-text').classes()).toContain('line-clamp-6');
        expect(
            wrapper.get('[data-testid="user-message-expand-toggle"]').attributes('aria-expanded')
        ).toBe('false');

        await wrapper.setProps({
            message: {
                id: 'user-second',
                role: 'user',
                content: 'now short',
                parts: [],
                timestamp: 1,
            } as SessionMessage,
        });
        await wrapper.vm.$nextTick();

        expect(wrapper.find('[data-testid="user-message-expand-toggle"]').exists()).toBe(false);

        wrapper.unmount();
    });
});

describe('UserMessage pending delivery', () => {
    it('user sees a queued message with muted tool-call text and a matching dashed outline', () => {
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
        expect(bubble.classes()).toContain('border-message-muted');
        expect(bubble.classes()).toContain('bg-transparent');
        expect(wrapper.get('.user-text').classes()).toContain('text-message-muted');
        expect(wrapper.get('.user-text').classes()).not.toContain('text-message-foreground');
        expect(wrapper.findComponent({ name: 'ActionButton' }).exists()).toBe(false);

        wrapper.unmount();
    });

    it('user sees icon-only steer, edit, and cancel actions on a queued message', async () => {
        const wrapper = mount(UserMessage, {
            props: {
                message: {
                    id: 'pending-queue',
                    role: 'user',
                    content: 'queued text',
                    parts: [],
                    timestamp: 1,
                    pendingDelivery: 'queue',
                } as SessionMessage,
            },
        });

        expect(wrapper.find('[data-testid="pending-message-actions"]').exists()).toBe(true);
        const sendNow = wrapper.get('[data-testid="pending-message-send-now"]');
        expect(sendNow.text().trim()).toBe('');
        expect(sendNow.attributes('aria-label')).toBe('插队');
        expect(sendNow.attributes('title')).toBe('插队');
        const sendNowIcon = sendNow.get('[data-testid="app-icon"]');
        expect(sendNowIcon.attributes('data-name')).toBe('arrow-up');
        expect(sendNowIcon.classes()).toEqual(expect.arrayContaining(['h-4', 'w-4']));
        for (const testId of [
            'pending-message-send-now',
            'pending-message-edit',
            'pending-message-remove',
        ]) {
            expect(wrapper.get(`[data-testid="${testId}"]`).classes()).not.toContain(
                'hover:bg-surface-hover'
            );
        }
        expect(
            wrapper
                .get('[data-testid="pending-message-edit"] [data-testid="app-icon"]')
                .attributes('data-name')
        ).toBe('edit');
        expect(
            wrapper
                .get('[data-testid="pending-message-remove"] [data-testid="app-icon"]')
                .attributes('data-name')
        ).toBe('x');
        expect(wrapper.find('[data-testid="pending-message-priority"]').exists()).toBe(false);

        await wrapper.get('[data-testid="pending-message-send-now"]').trigger('click');
        await wrapper.get('[data-testid="pending-message-edit"]').trigger('click');
        await wrapper.get('[data-testid="pending-message-remove"]').trigger('click');

        expect(wrapper.emitted('sendNow')).toEqual([['pending-queue']]);
        expect(wrapper.emitted('edit')).toEqual([['pending-queue']]);
        expect(wrapper.emitted('remove')).toEqual([['pending-queue']]);

        wrapper.unmount();
    });

    it('user sees a queued message highlighted as editing in the composer', async () => {
        const wrapper = mount(UserMessage, {
            props: {
                editing: true,
                message: {
                    id: 'pending-editing',
                    role: 'user',
                    content: 'queued text being edited',
                    parts: [],
                    timestamp: 1,
                    pendingDelivery: 'queue',
                } as SessionMessage,
            },
        });

        const bubble = wrapper.get('[data-pending-delivery="queue"]');
        expect(bubble.attributes('data-editing')).toBe('true');
        expect(bubble.classes()).toContain('border-primary-400');
        expect(bubble.classes()).toContain('bg-primary-50');
        expect(wrapper.get('[data-testid="pending-message-edit-status"]').text()).toBe('正在编辑');

        for (const testId of [
            'pending-message-send-now',
            'pending-message-edit',
            'pending-message-remove',
        ]) {
            expect(wrapper.find(`[data-testid="${testId}"]`).exists()).toBe(false);
        }

        await wrapper.get('[data-testid="pending-message-cancel-edit"]').trigger('click');
        expect(wrapper.emitted('cancelEdit')).toEqual([['pending-editing']]);

        wrapper.unmount();
    });

    it('user sees a pending steer as a solid bubble instead of a dashed queue', () => {
        const wrapper = mount(UserMessage, {
            props: {
                message: {
                    id: 'pending-priority',
                    role: 'user',
                    content: 'insert text',
                    parts: [],
                    timestamp: 1,
                    pendingDelivery: 'priority',
                } as SessionMessage,
            },
        });

        const bubble = wrapper.get('[data-pending-delivery="priority"]');
        expect(bubble.classes()).toContain('bg-secondary');
        expect(bubble.classes()).not.toContain('border-dashed');
        expect(bubble.classes()).not.toContain('bg-transparent');
        expect(wrapper.get('.user-text').classes()).toContain('text-message-foreground');

        wrapper.unmount();
    });

    it('user sees a pending steer as a normal message without pending actions', () => {
        const wrapper = mount(UserMessage, {
            props: {
                message: {
                    id: 'pending-priority',
                    role: 'user',
                    content: 'insert text',
                    parts: [],
                    timestamp: 1,
                    pendingDelivery: 'priority',
                } as SessionMessage,
            },
        });

        expect(wrapper.find('[data-testid="pending-message-actions"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="pending-message-send-now"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="pending-message-edit"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="pending-message-remove"]').exists()).toBe(false);
        expect(wrapper.findComponent({ name: 'ActionButton' }).exists()).toBe(true);

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
        expect(wrapper.get('.rounded-lg').classes()).toContain('bg-secondary');
        expect(wrapper.get('.user-text').classes()).toContain('text-message-foreground');

        wrapper.unmount();
    });
});
