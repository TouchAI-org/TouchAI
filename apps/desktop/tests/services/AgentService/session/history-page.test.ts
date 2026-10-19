import type { MessageRow } from '@database/queries/messages';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getSessionDataPageMock } = vi.hoisted(() => ({
    getSessionDataPageMock: vi.fn(),
}));

vi.mock('@database/queries/mcpServers', () => ({
    findAllMcpServers: vi.fn(async () => []),
}));

vi.mock('@/services/AgentService/session/manager', () => ({
    getSessionData: vi.fn(),
    getSessionDataPage: getSessionDataPageMock,
}));

import { loadSessionHistoryPage } from '@/services/AgentService/session/history';

const MESSAGE_TIME = '2026-05-29T00:00:00.000Z';

function createTextMessage(id: number, role: 'user' | 'assistant', content: string): MessageRow {
    return {
        id,
        session_id: 7,
        role,
        created_at: MESSAGE_TIME,
        updated_at: MESSAGE_TIME,
        attachments: [],
        parts: [
            {
                id: id * 10,
                message_id: id,
                type: 'text',
                content,
                data: '{}',
                tool_call_id: null,
                tool_kind: null,
                attachment_id: null,
                started_at: null,
                ended_at: null,
                sort_order: 0,
                created_at: MESSAGE_TIME,
                updated_at: MESSAGE_TIME,
            },
        ],
    } as unknown as MessageRow;
}

describe('loadSessionHistoryPage', () => {
    beforeEach(() => {
        getSessionDataPageMock.mockReset();
    });

    it('loads one page and exposes the oldest id as the next cursor', async () => {
        getSessionDataPageMock.mockResolvedValue({
            session: { id: 7 },
            messages: [
                createTextMessage(2, 'user', 'second page start'),
                createTextMessage(3, 'assistant', 'latest reply'),
            ],
            turns: [],
            attempts: [],
            model: null,
            hasMoreMessages: true,
        });

        const page = await loadSessionHistoryPage(7, { limit: 50 });

        expect(getSessionDataPageMock).toHaveBeenCalledWith(7, { limit: 50 });
        expect(page.hasMore).toBe(true);
        expect(page.oldestMessageId).toBe(2);
        expect(page.history.map((message) => message.content)).toEqual([
            'second page start',
            'latest reply',
        ]);
    });

    it('stops paging when the session fits in one page', async () => {
        getSessionDataPageMock.mockResolvedValue({
            session: { id: 7 },
            messages: [createTextMessage(1, 'user', 'only message')],
            turns: [],
            attempts: [],
            model: null,
            hasMoreMessages: false,
        });

        const page = await loadSessionHistoryPage(7, { limit: 50, beforeMessageId: 100 });

        expect(getSessionDataPageMock).toHaveBeenCalledWith(7, {
            limit: 50,
            beforeMessageId: 100,
        });
        expect(page.hasMore).toBe(false);
        expect(page.oldestMessageId).toBe(1);
        expect(page.history).toHaveLength(1);
    });
});
