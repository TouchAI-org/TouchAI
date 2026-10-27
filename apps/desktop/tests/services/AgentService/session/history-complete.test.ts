import type { MessageRow } from '@database/queries/messages';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getSessionDataMock } = vi.hoisted(() => ({
    getSessionDataMock: vi.fn(),
}));

vi.mock('@database/queries/mcpServers', () => ({
    findAllMcpServers: vi.fn(async () => []),
}));

vi.mock('@/services/AgentService/session/manager', () => ({
    getSessionData: getSessionDataMock,
}));

import { loadCompleteSessionHistory } from '@/services/AgentService/session/history';

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

describe('loadCompleteSessionHistory', () => {
    beforeEach(() => {
        getSessionDataMock.mockReset();
    });

    it('loads the whole session in one read, without a page cursor', async () => {
        const messages = [
            createTextMessage(1, 'user', 'first question'),
            createTextMessage(2, 'assistant', 'first answer'),
            createTextMessage(3, 'user', 'latest question'),
            createTextMessage(4, 'assistant', 'latest answer'),
        ];
        getSessionDataMock.mockResolvedValue({
            session: { id: 7, title: 'Long session' },
            messages,
            turns: [],
            attempts: [],
            model: { model_id: 'm', provider_id: 3 },
        });

        const loaded = await loadCompleteSessionHistory(7);

        // 只读一次，且不传任何分页参数：滚动条高度与时间轴定位需要完整列表。
        expect(getSessionDataMock).toHaveBeenCalledTimes(1);
        expect(getSessionDataMock).toHaveBeenCalledWith(7);
        expect(loaded.history.map((message) => message.content)).toEqual([
            'first question',
            'first answer',
            'latest question',
            'latest answer',
        ]);
        expect(loaded.session).toEqual({ id: 7, title: 'Long session' });
        expect(loaded.model).toEqual({ model_id: 'm', provider_id: 3 });
    });
});
