import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';

import { AiError, AiErrorCode } from '@/application/agentErrors';
import { useAgent } from '@/composables/agent/useAgent';
import { setLocale } from '@/i18n';

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

describe('useAgent i18n', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setLocale('zh-CN');
    });

    it('uses keyed localized empty prompt errors in the active locale', async () => {
        setLocale('en-US');
        const { agent, wrapper } = mountAgent();

        await agent.sendRequest('   ');

        expect(agent.error.value?.message).toBe('Enter a request');
        expect(startTaskMock).not.toHaveBeenCalled();

        wrapper.unmount();
    });

    it('uses keyed localized request failure notification titles while localizing known AiError bodies', async () => {
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
