import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';
import type { SessionMessage, ToolCallInfo } from '@/types/session';
import ToolCallItem from '@/views/SearchView/components/ConversationPanel/components/ToolCallItem.vue';
import UserMessage from '@/views/SearchView/components/ConversationPanel/components/UserMessage.vue';

const iconStub = {
    name: 'AppIcon',
    props: ['name'],
    template: '<span class="app-icon-stub" />',
};

function createDesktopContextToolCall(overrides: Partial<ToolCallInfo> = {}): ToolCallInfo {
    const result = JSON.stringify(
        {
            available: true,
            capsuleId: 'ctx-1',
            summary: 'Visual Studio Code focused with selected Rust error text.',
            selectedText: {
                available: true,
                source: 'windows-uia-focused-textpattern',
                textSummary: 'selected Rust error text',
                textLength: 24,
                truncated: false,
                fullText: 'selected Rust error text',
            },
            screenshot: {
                available: true,
                path: 'E:/TouchAI/data/desktop-context/screenshots/ctx-1.png',
                mimeType: 'image/png',
                width: 1200,
                height: 800,
                target: 'active_display',
                persisted: true,
                capturedAt: '2026-06-02T12:00:00.000Z',
                reason: null,
            },
        },
        null,
        2
    );

    return {
        id: 'call-1',
        name: 'GetDesktopContext',
        namespacedName: 'builtin__get_desktop_context',
        source: 'builtin',
        sourceLabel: '内置工具',
        arguments: {
            include: ['selected_text.full_text', 'screenshot.image'],
        },
        builtinPresentation: {
            verb: '已阅读',
            content: '桌面上下文',
        },
        result,
        status: 'completed',
        durationMs: 18,
        ...overrides,
    };
}

describe('desktop context conversation rendering', () => {
    beforeEach(() => {
        setLocale('zh-CN');
    });

    it('does not render desktop context artifacts inside the user message bubble', () => {
        const message: SessionMessage = {
            id: 'user-1',
            role: 'user',
            content: '解释我选中的内容',
            desktopContext: {
                capsuleId: 'ctx-1',
                capturedAt: '2026-06-02T12:00:00.000Z',
                summary: 'Visual Studio Code focused with selected Rust error text.',
                activeWindowTitle: 'main.rs - TouchAI',
                screenshotPath: 'E:/TouchAI/data/desktop-context/screenshots/ctx-1.png',
                screenshotMimeType: 'image/png',
                screenshotWidth: 1200,
                screenshotHeight: 800,
            },
            parts: [],
            timestamp: Date.now(),
        };

        const wrapper = mount(UserMessage, {
            props: { message },
            global: {
                stubs: {
                    AppIcon: iconStub,
                    ActionButton: true,
                },
            },
        });

        expect(wrapper.text()).toContain('解释我选中的内容');
        expect(wrapper.text()).not.toContain('桌面上下文');
        expect(wrapper.find('img[alt="呼出时桌面截图"]').exists()).toBe(false);
        expect(wrapper.text()).not.toContain('main.rs - TouchAI');
    });

    it('renders approved desktop context inside the tool call expansion with screenshot first', async () => {
        const wrapper = mount(ToolCallItem, {
            props: {
                toolCall: createDesktopContextToolCall(),
            },
            global: {
                stubs: {
                    AppIcon: iconStub,
                },
            },
        });

        expect(wrapper.text()).toContain('已阅读');
        expect(wrapper.text()).toContain('桌面上下文');

        await wrapper.get('button.tool-call-log-button').trigger('click');

        const screenshot = wrapper.get('.tool-call-desktop-context-screenshot');
        const rawBlock = wrapper.get('.tool-call-desktop-context-raw');
        expect(
            screenshot.element.compareDocumentPosition(rawBlock.element) &
                Node.DOCUMENT_POSITION_FOLLOWING
        ).toBeTruthy();
        expect(screenshot.attributes('src')).toContain('asset.localhost');
        expect(screenshot.attributes('src')).toContain('ctx-1.png');
        expect(rawBlock.text()).toContain('"fullText": "selected Rust error text"');
        expect(rawBlock.text()).toContain(
            '"path": "E:/TouchAI/data/desktop-context/screenshots/ctx-1.png"'
        );
    });
});
