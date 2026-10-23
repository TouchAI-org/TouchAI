import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';

import { useAgent } from '@/composables/agent/useAgent';
import { setLocale } from '@/i18n';
import { AiError, AiErrorCode } from '@/services/AgentService/contracts/errors';

const { notifyMock, startTaskMock } = vi.hoisted(() => ({
    notifyMock: vi.fn(),
    startTaskMock: vi.fn(),
}));

vi.mock('@database/queries/sessions', () => ({
    findSessionById: vi.fn(),
}));

vi.mock('@services/NotificationService', () => ({
    notify: notifyMock,
}));

vi.mock('@/services/AgentService', () => ({
    sessionTaskCenter: {
        attachSessionView: vi.fn(() => null),
        approveTaskToolCall: vi.fn(),
        cancelTask: vi.fn(),
        rejectTaskToolCall: vi.fn(),
        startTask: startTaskMock,
        subscribeTask: vi.fn(() => vi.fn()),
    },
}));

vi.mock('@/services/AgentService/session', () => ({
    buildSessionHistoryFromData: vi.fn(async () => []),
    getSessionData: vi.fn(),
}));

function mountAgent() {
    let agent: ReturnType<typeof useAgent> | null = null;
    const wrapper = mount(
        defineComponent({
            setup() {
                agent = useAgent();
                return () => null;
            },
        })
    );

    if (!agent) {
        throw new Error('useAgent did not initialize');
    }

    return { agent: agent as ReturnType<typeof useAgent>, wrapper };
}

describe('when the app language is not English', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setLocale('zh-CN');
    });

    it('user is told the prompt is empty in the app language', async () => {
        setLocale('en-US');
        const { agent, wrapper } = mountAgent();

        await agent.sendRequest('   ');

        expect(agent.error.value?.message).toBe('Enter a request');
        expect(startTaskMock).not.toHaveBeenCalled();

        wrapper.unmount();
    });

    it('user gets the request failure notification in the app language', async () => {
        setLocale('en-US');
        startTaskMock.mockRejectedValue(new AiError(AiErrorCode.EMPTY_RESPONSE));
        const { agent, wrapper } = mountAgent();

        await agent.sendRequest('hello');

        expect(agent.error.value?.message).toBe(
            'The model returned an empty response. Try asking again or switch models.'
        );
        expect(notifyMock).toHaveBeenCalledWith({
            title: 'TouchAI - Empty response',
            body: 'The model returned an empty response. Try asking again or switch models.',
        });

        wrapper.unmount();
    });
});
