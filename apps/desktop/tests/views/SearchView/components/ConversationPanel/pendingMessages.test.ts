import { describe, expect, it } from 'vitest';

import type { PendingUserMessage } from '@/services/AgentService/task/types';
import type { SessionMessage } from '@/types/session';
import { buildConversationDisplayMessages } from '@/views/SearchView/components/ConversationPanel/pendingMessages';

function createUserMessage(id: string, content: string): SessionMessage {
    return {
        id,
        role: 'user',
        content,
        parts: [],
        timestamp: 1,
    };
}

function createAssistantMessage(id: string, content: string): SessionMessage {
    return {
        id,
        role: 'assistant',
        content,
        parts: [],
        timestamp: 2,
        isStreaming: true,
    };
}

function createPendingMessage(
    id: string,
    prompt: string,
    delivery: PendingUserMessage['delivery'] = 'queue'
): PendingUserMessage {
    return {
        id,
        prompt,
        attachments: [],
        delivery,
        createdAt: 3,
    };
}

describe('user sees pending messages in the conversation', () => {
    it('user sees pending messages after the streaming assistant reply', () => {
        const messages = [
            createUserMessage('user-1', 'first'),
            createAssistantMessage('assistant-1', 'working'),
        ];

        const displayMessages = buildConversationDisplayMessages(messages, [
            createPendingMessage('pending-1', 'queued'),
        ]);

        expect(displayMessages.map((message) => message.id)).toEqual([
            'user-1',
            'assistant-1',
            'pending-1',
        ]);
        expect(displayMessages[2]).toMatchObject({
            id: 'pending-1',
            role: 'user',
            pendingDelivery: 'queue',
        });
    });

    it('user sees later pending messages in submission order below the first', () => {
        const displayMessages = buildConversationDisplayMessages(
            [createUserMessage('user-1', 'first')],
            [
                createPendingMessage('pending-1', 'queued first'),
                createPendingMessage('pending-2', 'queued second'),
            ]
        );

        expect(displayMessages.map((message) => message.id)).toEqual([
            'user-1',
            'pending-1',
            'pending-2',
        ]);
    });

    it('user sees a pending steer above the queue and below the loading row', () => {
        const displayMessages = buildConversationDisplayMessages(
            [
                createUserMessage('user-1', 'first'),
                createAssistantMessage('assistant-1', 'working'),
            ],
            [
                createPendingMessage('pending-queue', 'after the turn', 'queue'),
                createPendingMessage('pending-steer', 'steer now', 'priority'),
            ]
        );

        expect(displayMessages.map((message) => message.id)).toEqual([
            'user-1',
            'assistant-1',
            'pending-steer',
            'pending-queue',
        ]);
        expect(displayMessages[2]).toMatchObject({
            id: 'pending-steer',
            role: 'user',
            pendingDelivery: 'priority',
        });
    });
});
