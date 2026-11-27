import type { AgentCard } from '@a2a-js/sdk';

import type {
    ExternalAgentCard,
    ExternalAgentInvocationMode,
    ExternalAgentInvocationResult,
    ExternalAgentPollingOptions,
} from './contracts';

export type ExternalAgentWireProtocol = 'a2a' | 'acp';

export interface ExternalAgentAdapterDiscoveryInput {
    allowLoopback: boolean;
    fetchImpl: typeof fetch;
    signal?: AbortSignal;
    timeoutMs: number;
    url: string;
}

export interface ExternalAgentAdapterInvocationInput {
    allowLoopback: boolean;
    card: AgentCard;
    fetchImpl: typeof fetch;
    message: string;
    mode: ExternalAgentInvocationMode;
    onSnapshot?(text: string): void;
    polling?: Partial<ExternalAgentPollingOptions>;
    signal?: AbortSignal;
    streamSnapshotIntervalMs?: number;
    timeoutMs?: number;
    url: string;
}

/**
 * Normalization seam for protocols that predate A2A. Implementations must
 * return the same card, invocation, error, cancellation, and limit contracts
 * as the A2A REST adapter; approval and credential policy stay outside it.
 */
export interface ExternalAgentProtocolAdapter {
    readonly protocol: ExternalAgentWireProtocol;
    discover(input: ExternalAgentAdapterDiscoveryInput): Promise<ExternalAgentCard>;
    invoke(input: ExternalAgentAdapterInvocationInput): Promise<ExternalAgentInvocationResult>;
}
