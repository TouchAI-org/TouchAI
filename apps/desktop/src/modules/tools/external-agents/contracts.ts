import type { AgentCard, AgentInterface } from '@a2a-js/sdk';

export type ExternalAgentInvocationMode = 'auto' | 'sync' | 'stream' | 'async';

export type ExternalAgentErrorCode =
    | 'agent_unavailable'
    | 'auth_required'
    | 'card_malformed'
    | 'cancelled'
    | 'discovery_unavailable'
    | 'interface_unavailable'
    | 'invalid_response'
    | 'payload_too_large'
    | 'polling_timeout'
    | 'request_failed'
    | 'stream_disconnected'
    | 'timeout'
    | 'unsafe_url';

export interface ExternalAgentCard {
    readonly card: AgentCard;
    readonly compatibleInterface: AgentInterface;
    readonly origin: string;
    readonly url: string;
}

export interface ExternalAgentInvocationResult {
    readonly code?: ExternalAgentErrorCode;
    readonly sideEffect: 'none' | 'completed' | 'unknown';
    readonly status: 'success' | 'error' | 'timeout';
    readonly taskId?: string;
    readonly text: string;
}

export interface ExternalAgentPollingOptions {
    initialDelayMs: number;
    maxDelayMs: number;
    timeoutMs: number;
}

export interface ExternalAgentRecord {
    readonly id: number;
    readonly name: string;
    readonly url: string;
    readonly protocol: 'a2a';
    readonly agent_card_json: string;
    readonly enabled: number;
    readonly last_discovered_at: string | null;
    readonly last_error: string | null;
    readonly created_at: string;
    readonly updated_at: string;
}

export interface ExternalAgentAdministration {
    add(input: { allowLoopback: boolean; url: string }): Promise<ExternalAgentRecord>;
    delete(id: number): Promise<void>;
    findAll(): Promise<ExternalAgentRecord[]>;
    rediscover(id: number): Promise<ExternalAgentRecord>;
    updateEnabled(id: number, enabled: boolean): Promise<ExternalAgentRecord | undefined>;
}

export interface ExternalAgentRegistry {
    findEnabled(id: number): Promise<{ card: AgentCard; row: ExternalAgentRecord } | null>;
    list(): Promise<ExternalAgentRecord[]>;
}
