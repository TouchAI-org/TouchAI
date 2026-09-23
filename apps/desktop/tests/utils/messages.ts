import type { MessageRow } from '@database/queries/messages';
import type { MessagePartEntity } from '@database/types';

export const MESSAGE_TIME = '2026-05-22T10:00:00.000Z';

export function createMessagePart(overrides: Partial<MessagePartEntity> = {}): MessagePartEntity {
    const data = JSON.parse(overrides.data ?? '{}') as Record<string, unknown>;
    return {
        id: 1,
        message_id: 1,
        type: 'text',
        content: '',
        data: '{}',
        tool_call_id: typeof data.toolCallId === 'string' ? data.toolCallId : null,
        tool_kind: data.toolKind === 'builtin' || data.toolKind === 'mcp' ? data.toolKind : null,
        attachment_id: typeof data.attachmentId === 'number' ? data.attachmentId : null,
        started_at: null,
        ended_at: null,
        sort_order: 0,
        created_at: MESSAGE_TIME,
        updated_at: MESSAGE_TIME,
        ...overrides,
    };
}

export function createMessageRow(
    overrides: Partial<MessageRow> & { content?: string } = {}
): MessageRow {
    const { content = '', ...row } = overrides;
    return {
        id: 1,
        session_id: 1,
        role: 'user',
        parts: content ? [createMessagePart({ message_id: row.id ?? 1, content })] : [],
        attachments: [],
        created_at: MESSAGE_TIME,
        updated_at: MESSAGE_TIME,
        ...row,
    };
}
