import type { StoredContextAttachment, StoredContextPart } from './contextRead';
import type { AttachmentReference } from './history';
import type { AgentPresentationTools } from './presentation';

export interface HistoryPart extends StoredContextPart {
    id: number;
    created_at: string;
    updated_at: string;
    started_at: number | null;
    ended_at: number | null;
}

export interface HistoryMessage {
    id: number;
    role: string;
    created_at: string;
    parts: HistoryPart[];
    attachments: StoredContextAttachment[];
}

export interface HistoryTurn {
    id: number;
    prompt_snapshot_json: string;
    prompt_message_id: number | null;
    response_message_id: number | null;
    status: 'pending' | 'streaming' | 'completed' | 'failed' | 'cancelled';
    error_message: string | null;
    created_at: string;
    updated_at: string;
}

export interface HistoryAttempt {
    id: number;
    turn_id: number;
    attempt_index: number;
    max_retries: number;
    finished_at: string | null;
    created_at: string;
    updated_at: string;
}

export interface StoredSession {
    id: number;
    session_id: string;
    title: string;
    model: string | null;
    provider_id: number | null;
    created_at: string;
    updated_at: string;
}

export interface SessionListItem extends StoredSession {
    last_message_preview: string | null;
    last_message_at: string | null;
    message_count: number;
    status_badge_dismissed_turn_id: number | null;
    pending_terminal_status: 'completed' | 'failed' | null;
    pinned_at: string | null;
    archived_at: string | null;
}

export interface SessionListOptions { query?: string; limit?: number; }

/** Internal history input. It is never a UI API or a model transport message. */
export interface SessionHistoryData {
    session: StoredSession;
    messages: HistoryMessage[];
    turns: HistoryTurn[];
    attempts: HistoryAttempt[];
}

export type HistoryToolStatus = 'pending' | 'approved' | 'success' | 'error' | 'timeout' |
    'cancelled' | 'awaiting_approval' | 'rejected';

export interface HistoryToolData {
    toolCallId: string;
    toolKind: 'builtin' | 'mcp';
    requestedName?: string;
    tool_id?: string;
    server_id?: number;
    tool_name?: string;
    input: string;
    output?: string | null;
    status?: HistoryToolStatus;
    duration_ms?: number | null;
    conversation_semantic_json?: string | null;
    structured_payload_json?: string | null;
}

export interface SessionHistoryHost {
    hydrateAttachments(rows: StoredContextAttachment[]): Promise<AttachmentReference[]>;
    tools: AgentPresentationTools;
    messages: {
        tt(text: string, values?: Record<string, string | number>): string;
        displayError(message: string): string;
        retryText(attempt: number, maxRetries: number): string;
    };
    diagnostics: { error(message: string, error: unknown): void };
}

export function readHistoryToolData(part: { data: string }): HistoryToolData {
    return JSON.parse(part.data) as HistoryToolData;
}

export function historyToolName(data: HistoryToolData): string {
    if (typeof data.requestedName === 'string') return data.requestedName;
    return data.toolKind === 'builtin' ? `builtin__${data.tool_id}` : `mcp__${data.server_id}__${data.tool_name}`;
}
