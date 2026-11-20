import type { ContextSummary } from './context';

export interface StoredContextPart {
    type: string;
    content: string;
    data: string;
    sort_order: number;
}

export interface StoredContextAttachment {
    id: number;
    hash: string;
    type: 'image' | 'file';
    original_name: string;
    origin_path: string;
    mime_type: string | null;
    size: number | null;
    created_at: string;
    message_id: number;
    sort_order: number;
    tool_call_id: string | null;
    tool_kind: string | null;
}

export interface StoredContextMessage {
    id: number;
    role: string;
    parts: StoredContextPart[];
    attachments: StoredContextAttachment[];
}

export interface SessionContext {
    messages: StoredContextMessage[];
    summary?: ContextSummary;
    summaryPartId?: number;
}

export interface SessionReadModel {
    getMessages(sessionId: number): Promise<StoredContextMessage[]>;
    getContext(sessionId: number): Promise<SessionContext>;
}

export function readStoredText(parts: readonly StoredContextPart[]): string {
    return parts.filter((part) => part.type === 'text').map((part) => part.content).join('');
}

export function readStoredToolCall(part: StoredContextPart) {
    const data = JSON.parse(part.data) as { toolCallId: string; toolKind: 'builtin' | 'mcp';
        tool_id?: string; server_id?: number; tool_name?: string; requestedName?: string;
        input: string; output?: string | null; status?: string };
    const name = typeof data.requestedName === 'string' ? data.requestedName : data.toolKind === 'builtin'
        ? `builtin__${data.tool_id}` : `mcp__${data.server_id}__${data.tool_name}`;
    return { id: data.toolCallId, name, kind: data.toolKind, input: data.input, output: data.output, status: data.status };
}
