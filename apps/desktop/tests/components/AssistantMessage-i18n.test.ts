import { notify } from '@services/NotificationService';
import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

import { clipboardService } from '@/services/ClipboardService';
import type { SessionMessage } from '@/types/session';
import AssistantMessage from '@/views/SearchView/components/ConversationPanel/components/AssistantMessage.vue';

vi.mock('@/i18n', () => {
    const sourceTextTranslations: Record<string, string> = {
        'Shift+Enter 换行，适合分段表述': 'Shift+Enter inserts a new line for structured prompts',
        'Ctrl+M 或点击模型图标切换模型': 'Ctrl+M or the model icon switches models',
        'Ctrl+H 快速打开历史会话': 'Ctrl+H opens conversation history',
        'Ctrl+P 切换窗口置顶': 'Ctrl+P toggles always on top',
        'Ctrl+N 开启新会话': 'Ctrl+N starts a new conversation',
        右上角历史按钮可查看和切换历史会话:
            'Use the history button in the top right to view and switch conversations',
        消息下方按钮可复制内容: 'Buttons below a message can copy content',
        消息下方按钮可重新生成回复: 'Buttons below a message can regenerate the reply',
        复制消息: 'Copy message',
        重新生成回复: 'Regenerate response',
        思考中: 'Thinking',
        推理过程: 'Reasoning',
    };
    const keyedTranslations: Record<string, string> = {
        'assistant.action.copyMessage': 'Copy message',
        'assistant.action.regenerateResponse': 'Regenerate response',
        'assistant.reasoning.thinking': 'Thinking',
        'assistant.reasoning.title': 'Reasoning',
        'assistant.loadingTip.newLine': 'Shift+Enter inserts a new line for structured prompts',
        'assistant.loadingTip.switchModel': 'Ctrl+M or the model icon switches models',
        'assistant.loadingTip.history': 'Ctrl+H opens conversation history',
        'assistant.loadingTip.alwaysOnTop': 'Ctrl+P toggles always on top',
        'assistant.loadingTip.newSession': 'Ctrl+N starts a new conversation',
        'assistant.loadingTip.historyButton':
            'Use the history button in the top right to view and switch conversations',
        'assistant.loadingTip.copy': 'Buttons below a message can copy content',
        'assistant.loadingTip.regenerate': 'Buttons below a message can regenerate the reply',
        'notification.copy.copiedToClipboard': 'Copied to clipboard',
        'common.copyFailed': 'Copy failed',
    };

    return {
        t: (key: string) => keyedTranslations[key] ?? key,
        tt: (text: string) => sourceTextTranslations[text] ?? text,
    };
});

vi.mock('@components/AppIcon.vue', () => ({
    default: {
        name: 'AppIcon',
        template: '<span data-testid="app-icon" />',
    },
}));

vi.mock('@components/ActionButton.vue', () => ({
    default: {
        name: 'ActionButton',
        props: ['icon', 'handler'],
        template:
            '<button :data-icon="icon" data-testid="action-button" v-bind="$attrs" @click="handler" />',
    },
}));

vi.mock('@components/MarkdownContent.vue', () => ({
    default: {
        name: 'MarkdownContent',
        props: ['content'],
        template: '<div data-testid="markdown-content">{{ content }}</div>',
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

vi.mock('@/views/SearchView/components/ConversationPanel/components/ToolCallItem.vue', () => ({
    default: {
        name: 'ToolCallItem',
        template: '<div data-testid="tool-call-item" />',
    },
}));

vi.mock('@/views/SearchView/components/ConversationPanel/components/WidgetFrame.vue', () => ({
    default: {
        name: 'WidgetFrame',
        template: '<div data-testid="widget-frame" />',
    },
}));

vi.mock('@/views/SearchView/components/ConversationPanel/components/ToolApprovalCard.vue', () => ({
    default: {
        name: 'ToolApprovalCard',
        template: '<div data-testid="tool-approval-card" />',
    },
}));

function createAssistantMessage(overrides: Partial<SessionMessage> = {}): SessionMessage {
    return {
        id: 'assistant-1',
        role: 'assistant',
        content: '助手回复',
        parts: [
            {
                id: 'text-1',
                type: 'text',
                content: '助手回复',
            },
        ],
        timestamp: Date.now(),
        ...overrides,
    };
}

describe('AssistantMessage i18n boundaries', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('uses keyed localized copy success notifications', async () => {
        vi.mocked(clipboardService.writeText).mockResolvedValue(undefined);
        const wrapper = mount(AssistantMessage, {
            props: {
                message: createAssistantMessage({
                    content: '复制这段助手回复',
                }),
            },
        });

        await wrapper.get('[data-icon="copy"]').trigger('click');

        expect(clipboardService.writeText).toHaveBeenCalledWith('复制这段助手回复');
        expect(notify).toHaveBeenCalledWith({
            title: 'TouchAI',
            body: 'Copied to clipboard',
        });
    });

    it('uses keyed localized copy failure notifications', async () => {
        vi.mocked(clipboardService.writeText).mockRejectedValue(new Error('clipboard denied'));
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const wrapper = mount(AssistantMessage, {
            props: {
                message: createAssistantMessage({
                    content: '无法复制的助手回复',
                }),
            },
        });

        await wrapper.get('[data-icon="copy"]').trigger('click');

        expect(notify).toHaveBeenCalledWith({
            title: 'TouchAI',
            body: 'Copy failed',
        });
    });

    it('localizes message action accessibility labels', () => {
        const wrapper = mount(AssistantMessage, {
            props: {
                message: createAssistantMessage(),
            },
        });

        const buttons = wrapper.findAll('[data-testid="action-button"]');
        expect(buttons).toHaveLength(2);
        expect(buttons[0]?.attributes('aria-label')).toBe('Copy message');
        expect(buttons[1]?.attributes('aria-label')).toBe('Regenerate response');
    });

    it('localizes reasoning section titles', () => {
        const wrapper = mount(AssistantMessage, {
            props: {
                message: createAssistantMessage({
                    content: 'final answer',
                    reasoning: 'hidden chain summary',
                }),
            },
        });

        expect(wrapper.text()).toContain('Reasoning');
        expect(wrapper.text()).not.toContain('推理过程');
    });

    it('localizes streaming reasoning title before content starts', () => {
        const wrapper = mount(AssistantMessage, {
            props: {
                message: createAssistantMessage({
                    content: '',
                    isStreaming: true,
                    reasoning: 'thinking summary',
                    parts: [],
                }),
            },
        });

        expect(wrapper.text()).toContain('Thinking');
        expect(wrapper.text()).not.toContain('思考中');
    });

    it('renders delayed loading tips through the active locale while rotating tips', async () => {
        vi.useFakeTimers();
        const wrapper = mount(AssistantMessage, {
            props: {
                message: createAssistantMessage({
                    content: '',
                    isStreaming: true,
                    parts: [],
                }),
            },
        });

        expect(wrapper.find('.loading-tip').exists()).toBe(false);

        vi.advanceTimersByTime(20000);
        await nextTick();

        expect(wrapper.get('.loading-tip').text()).toBe(
            'Shift+Enter inserts a new line for structured prompts'
        );

        vi.advanceTimersByTime(5000);
        await nextTick();

        expect(wrapper.get('.loading-tip').text()).toBe('Ctrl+M or the model icon switches models');
    });
});
