import { useTestPrivacyWindow } from '@tests/utils/privacyWindow';

useTestPrivacyWindow();

import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionMessage } from '@/app/api/agent/history';
import { setLocale } from '@/i18n';
import AssistantMessage from '@/views/SearchView/components/ConversationPanel/components/AssistantMessage.vue';

const exportResultMessage = vi.hoisted(() => vi.fn());
const createResultExportPresentation = vi.hoisted(() =>
    vi.fn(() => ({
        theme: {},
        themeFallbacks: {},
        baseStyles: '',
    }))
);

vi.mock('@/app/api/agent/resultExport', () => ({
    exportAssistantResult: exportResultMessage,
}));
vi.mock('@/components/widgets/resultExportPresentation', () => ({
    createResultExportPresentation,
}));
vi.mock('@/stores/askUser', () => ({ useAskUserStore: () => ({ current: null }) }));
vi.mock('@/app/api/windows/notifications', () => ({ notify: vi.fn() }));
vi.mock('@/components/MarkdownContent.vue', () => ({
    default: {
        props: ['content', 'final', 'variant'],
        template: '<div class="markdown">{{ content }}</div>',
    },
}));
vi.mock('@/views/SearchView/components/ConversationPanel/components/ToolCallItem.vue', () => ({
    default: { template: '<div>Tool</div>' },
}));
vi.mock('@/views/SearchView/components/ConversationPanel/components/WidgetFrame.vue', () => ({
    default: { template: '<div>Widget</div>' },
}));
vi.mock(
    '@/views/SearchView/components/ConversationPanel/components/ToolApprovalHistoryCard.vue',
    () => ({ default: { template: '<div>Approval</div>' } })
);

const wrappers: VueWrapper[] = [];

function render(overrides: Partial<SessionMessage> = {}) {
    const wrapper = mount(AssistantMessage, {
        props: {
            message: {
                id: 'answer',
                role: 'assistant',
                content: 'Answer',
                parts: [{ id: 'text-1', type: 'text', content: 'Answer' }],
                timestamp: 1,
                ...overrides,
            },
        },
        global: {
            stubs: {
                AppIcon: { props: ['name'], template: '<svg :data-icon="name" />' },
            },
        },
    });
    wrappers.push(wrapper);
    return wrapper;
}

beforeEach(() => {
    setLocale('en-US');
});

afterEach(() => {
    wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
});

describe('user shares a completed assistant result', () => {
    it('user sees the save action only after the assistant result has completed', async () => {
        const wrapper = render();
        expect(wrapper.find('button[aria-label="Save result"]').exists()).toBe(true);

        await wrapper.setProps({
            message: {
                ...wrapper.props('message'),
                isStreaming: true,
            },
        });
        expect(wrapper.find('button[aria-label="Save result"]').exists()).toBe(false);

        for (const terminal of [{ isError: true }, { isCancelled: true }, { isRetrying: true }]) {
            await wrapper.setProps({
                message: {
                    ...wrapper.props('message'),
                    isStreaming: false,
                    isError: false,
                    isCancelled: false,
                    isRetrying: false,
                    ...terminal,
                },
            });
            expect(wrapper.find('button[aria-label="Save result"]').exists()).toBe(false);
        }
    });

    it('user gets a visible outcome after choosing a destination', async () => {
        exportResultMessage.mockResolvedValue({
            status: 'saved',
            warnings: [],
        });
        const wrapper = render();

        await wrapper.get('button[aria-label="Save result"]').trigger('click');
        await Promise.resolve();

        expect(exportResultMessage).toHaveBeenCalledTimes(1);
    });

    it('user only gets the save action for text or a ready widget', async () => {
        const widgetPart = { id: 'widget-part', type: 'widget' as const, widgetId: 'widget-1' };
        const draftWidget = {
            id: 'internal-row-id',
            callId: 'internal-call-id',
            widgetId: 'widget-1',
            title: 'Draft',
            description: '',
            html: '<div>Still rendering</div>',
            mode: 'render' as const,
            phase: 'draft' as const,
            updatedAt: 1,
        };
        const wrapper = render({
            content: '',
            parts: [widgetPart],
            widgets: [draftWidget],
        });

        expect(wrapper.find('button[aria-label="Save result"]').exists()).toBe(false);

        await wrapper.setProps({
            message: {
                ...wrapper.props('message'),
                widgets: [{ ...draftWidget, phase: 'ready' }],
            },
        });

        expect(wrapper.find('button[aria-label="Save result"]').exists()).toBe(true);
    });

    it('user does not get the save action while a tool is still executing', async () => {
        const toolPart = {
            id: 'tool-part',
            type: 'tool_call' as const,
            toolCall: {
                id: 'tool-call',
                name: 'search',
                namespacedName: 'builtin__search',
                source: 'builtin' as const,
                arguments: {},
                status: 'executing' as const,
            },
        };
        const wrapper = render({ content: '', parts: [toolPart] });

        expect(wrapper.find('button[aria-label="Save result"]').exists()).toBe(false);

        await wrapper.setProps({
            message: {
                ...wrapper.props('message'),
                parts: [
                    {
                        ...toolPart,
                        toolCall: { ...toolPart.toolCall, status: 'completed' },
                    },
                    { id: 'text-1', type: 'text', content: 'Finished answer' },
                ],
            },
        });

        expect(wrapper.find('button[aria-label="Save result"]').exists()).toBe(true);
    });
});
