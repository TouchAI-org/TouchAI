import { notify } from '@services/NotificationService';
import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import { clipboardService } from '@/services/ClipboardService';
import type { SessionMessage } from '@/types/session';
import UserMessage from '@/views/SearchView/components/ConversationPanel/components/UserMessage.vue';

vi.mock('@components/AppIcon.vue', () => ({
    default: {
        name: 'AppIcon',
        template: '<span data-testid="app-icon" />',
    },
}));

vi.mock('@components/ActionButton.vue', () => ({
    default: {
        name: 'ActionButton',
        props: ['handler'],
        template: '<button data-testid="action-button" v-bind="$attrs" @click="handler" />',
    },
}));

vi.mock('@services/NotificationService', () => ({
    notify: vi.fn(),
}));

vi.mock('@/services/ClipboardService', () => ({
    clipboardService: {
        writeText: vi.fn(),
    },
}));

function createUserMessage(overrides: Partial<SessionMessage> = {}): SessionMessage {
    return {
        id: 'user-1',
        role: 'user',
        content: '设置',
        parts: [],
        timestamp: Date.now(),
        ...overrides,
    };
}

describe('UserMessage i18n boundaries', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setLocale('zh-CN');
    });

    it('marks user-authored text and attachment names as not eligible for global DOM localization', () => {
        const wrapper = mount(UserMessage, {
            props: {
                message: createUserMessage({
                    attachments: [
                        {
                            id: 'image-1',
                            type: 'image',
                            path: 'E:/tmp/image.png',
                            originPath: 'E:/tmp/image.png',
                            name: '关闭',
                            preview: 'data:image/png;base64,abc',
                        },
                        {
                            id: 'file-1',
                            type: 'file',
                            path: 'E:/tmp/file.txt',
                            originPath: 'E:/tmp/file.txt',
                            name: '设置.txt',
                        },
                    ],
                }),
            },
        });

        const userText = wrapper.get('.user-text');
        expect(userText.attributes('data-no-i18n')).toBe('true');
        expect(userText.attributes('translate')).toBe('no');

        const image = wrapper.get('img');
        expect(image.attributes('alt')).toBe('关闭');
        expect(image.attributes('data-no-i18n')).toBe('true');
        expect(image.attributes('translate')).toBe('no');

        const fileName = wrapper.get('.text-sm.text-gray-700');
        expect(fileName.text()).toBe('设置.txt');
        expect(fileName.attributes('data-no-i18n')).toBe('true');
        expect(fileName.attributes('translate')).toBe('no');
    });

    it('localizes generated attachment fallbacks while still protecting real payload names', () => {
        setLocale('en-US');
        const wrapper = mount(UserMessage, {
            props: {
                message: createUserMessage({
                    content: '',
                    attachments: [
                        {
                            id: 'image-1',
                            type: 'image',
                            path: 'E:/tmp/image.png',
                            originPath: 'E:/tmp/image.png',
                            name: '',
                            preview: 'data:image/png;base64,abc',
                        },
                        {
                            id: 'file-1',
                            type: 'file',
                            path: 'E:/tmp/file.txt',
                            originPath: 'E:/tmp/file.txt',
                            name: '',
                        },
                    ],
                }),
            },
        });

        const image = wrapper.get('img');
        expect(image.attributes('alt')).toBe('Image');
        expect(image.attributes('data-no-i18n')).toBe('true');

        const fileName = wrapper.get('.text-sm.text-gray-700');
        expect(fileName.text()).toBe('File');
        expect(fileName.attributes('data-no-i18n')).toBe('true');
    });

    it('localizes copy action accessibility label', () => {
        setLocale('en-US');
        const wrapper = mount(UserMessage, {
            props: {
                message: createUserMessage(),
            },
        });

        expect(wrapper.get('[data-testid="action-button"]').attributes('aria-label')).toBe(
            'Copy message'
        );
    });

    it('uses keyed localized copy success notifications', async () => {
        setLocale('en-US');
        vi.mocked(clipboardService.writeText).mockResolvedValue(undefined);
        const wrapper = mount(UserMessage, {
            props: {
                message: createUserMessage({
                    content: '复制这段用户输入',
                }),
            },
        });

        await wrapper.get('[data-testid="action-button"]').trigger('click');

        expect(clipboardService.writeText).toHaveBeenCalledWith('复制这段用户输入');
        expect(notify).toHaveBeenCalledWith({
            title: 'TouchAI',
            body: 'Copied to clipboard',
        });
    });

    it('uses keyed localized copy failure notifications', async () => {
        setLocale('en-US');
        vi.mocked(clipboardService.writeText).mockRejectedValue(new Error('clipboard denied'));
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const wrapper = mount(UserMessage, {
            props: {
                message: createUserMessage({
                    content: '无法复制的用户输入',
                }),
            },
        });

        await wrapper.get('[data-testid="action-button"]').trigger('click');

        expect(notify).toHaveBeenCalledWith({
            title: 'TouchAI',
            body: 'Copy failed',
        });
    });
});
