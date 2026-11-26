import { useTestPrivacyWindow } from '@tests/utils/privacyWindow';

useTestPrivacyWindow();

import { createAgentProjection } from '@tests/utils/agentProjection';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionMessage } from '@/app/api/agent/history';
import { setLocale } from '@/i18n';
import type { TaskViewSnapshot } from '@/modules/agent/contracts';
import ConversationPanel from '@/views/SearchView/components/ConversationPanel/index.vue';

const RETRY_TEXT = '重试中...(2/5)';

const settingsStoreMock = vi.hoisted(() => ({
    outputScrollBehavior: { value: 'follow_output' } as { value: string },
    initialize: vi.fn().mockResolvedValue(undefined),
}));

const scrollerMock = vi.hoisted(() => ({
    focus: vi.fn(),
    getState: vi.fn(),
    getViewportElement: vi.fn(() => null),
    isAtEnd: vi.fn(() => true),
    recalculate: vi.fn(),
    scrollBy: vi.fn(),
    scrollToEnd: vi.fn(),
    scrollToItem: vi.fn(() => true),
}));

vi.mock('pinia', async (importOriginal) => {
    const actual = await importOriginal<typeof import('pinia')>();
    const { ref } = await import('vue');
    settingsStoreMock.outputScrollBehavior = ref(settingsStoreMock.outputScrollBehavior.value);
    return {
        ...actual,
        storeToRefs: () => ({ outputScrollBehavior: settingsStoreMock.outputScrollBehavior }),
    };
});

vi.mock('@/stores/settings', () => ({
    useSettingsStore: () => settingsStoreMock,
}));

vi.mock('@/components/ui/message-scroller', async () => {
    const { defineComponent, h } = await import('vue');
    return {
        MessageScroller: defineComponent({
            name: 'MessageScrollerStub',
            inheritAttrs: false,
            props: { items: { type: Array, default: () => [] } },
            emits: ['stateChange'],
            setup(_, { expose, slots }) {
                expose(scrollerMock);
                return () => h('div', { 'data-testid': 'message-scroller' }, slots.default?.());
            },
        }),
    };
});

function createSnapshot(): TaskViewSnapshot {
    return {
        taskId: 'task-1',
        sessionId: 1,
        turnId: null,
        status: 'running',
        executionMode: 'foreground',
        sessionHistory: [],
        pendingUserMessages: [],
        pendingToolApproval: null,
        pendingApprovals: [],
        pendingUserQuestion: null,
        error: null,
        currentModel: null,
        startedAt: 1,
        updatedAt: 1,
        modelSwitchCount: 0,
    };
}

function retryEvent(retryScope: 'restart' | 'checkpoint') {
    return {
        type: 'request_retry',
        attempt: 2,
        maxRetries: 5,
        reason: 'network',
        retryScope,
        resumeFromIteration: retryScope === 'checkpoint' ? 1 : 0,
        discardVisibleOutputSinceCheckpoint: false,
        discardToolActivitySinceCheckpoint: false,
    };
}

function mountPanel(messages: SessionMessage[]) {
    return mount(ConversationPanel, {
        props: {
            startDragging: vi.fn().mockResolvedValue(undefined),
            messages,
            isLoading: true,
            error: null,
            isPinned: false,
            historyOpen: false,
        },
        global: {
            stubs: {
                MarkdownContent: {
                    props: ['content'],
                    template: '<div class="markdown">{{ content }}</div>',
                },
            },
        },
    });
}

/** Run a real retry through the projection so the panel receives live task output. */
function retryInFlight(retryScope: 'restart' | 'checkpoint') {
    const snapshot = createSnapshot();
    const projection = createAgentProjection(snapshot, vi.fn());
    projection.bootstrap([], 'Run it', []);
    projection.handleChunk({ content: 'Step one', done: false } as never);
    if (retryScope === 'checkpoint') {
        projection.syncTaskMetadata({
            type: 'checkpoint_committed',
            taskId: 'task-1',
            checkpoint: { attempt: 1, iteration: 1, messages: [] },
        } as never);
    }
    projection.handleChunk({ toolEvent: retryEvent(retryScope) } as never);
    return {
        history: snapshot.sessionHistory,
        pendingId: projection.getActiveAssistantMessageId()!,
    };
}

beforeEach(() => {
    setLocale('zh-CN');
    settingsStoreMock.initialize.mockClear();
    let uuidIndex = 0;
    vi.spyOn(crypto, 'randomUUID').mockImplementation(
        () => `00000000-0000-4000-8000-${String(++uuidIndex).padStart(12, '0')}`
    );
});

describe('user waits through an automatic retry', () => {
    it('user sees the retry state inside the pending answer when a tool-loop retry resumes', async () => {
        const { history, pendingId } = retryInFlight('checkpoint');

        const wrapper = mountPanel(history);
        await flushPromises();

        const pendingAnswer = wrapper.get(`[data-message-id="${pendingId}"]`);
        expect(pendingAnswer.get('[data-request-status]').text()).toContain(RETRY_TEXT);
        expect(pendingAnswer.text()).toContain('Step one');
        expect(wrapper.findAll('[data-message-role="assistant"]')).toHaveLength(1);
    });

    it('user sees the retry state inside the restarted answer instead of a status row of its own', async () => {
        const { history, pendingId } = retryInFlight('restart');

        const wrapper = mountPanel(history);
        await flushPromises();

        const pendingAnswer = wrapper.get(`[data-message-id="${pendingId}"]`);
        expect(pendingAnswer.get('[data-request-status]').text()).toContain(RETRY_TEXT);
        expect(wrapper.text().split(RETRY_TEXT)).toHaveLength(2);
        // The abandoned attempt keeps its own answer row; only the pending one carries the status.
        expect(wrapper.findAll('[data-message-role="assistant"]')).toHaveLength(2);
        expect(pendingAnswer.text()).not.toContain('Step one');
    });

    it('user does not get the retry state in the conversation toolbar', async () => {
        const { history } = retryInFlight('checkpoint');

        const wrapper = mountPanel(history);
        await flushPromises();

        expect(wrapper.get('[data-slot="conversation-toolbar"]').text()).not.toContain(RETRY_TEXT);
    });
});
