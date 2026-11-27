import { inject, type InjectionKey } from 'vue';

export interface ExternalAgentEntity {
    id: number;
    name: string;
    url: string;
    protocol: 'a2a';
    enabled: number;
    last_discovered_at: string | null;
    last_error: string | null;
    created_at: string;
    updated_at: string;
}

export interface ExternalAgentsAdministrationApi {
    add(input: { url: string; allowLoopback: boolean }): Promise<ExternalAgentEntity>;
    delete(id: number): Promise<void>;
    findAll(): Promise<ExternalAgentEntity[]>;
    rediscover(id: number): Promise<ExternalAgentEntity>;
    updateEnabled(id: number, enabled: boolean): Promise<ExternalAgentEntity | undefined>;
}

export class ExternalAgentCommandError extends Error {
    constructor(
        readonly code:
            | 'EXTERNAL_AGENT_COMMAND_UNAVAILABLE'
            | 'EXTERNAL_AGENT_COMMAND_UNCONFIRMED'
            | 'EXTERNAL_AGENT_COMMAND_FAILED',
        readonly outcome: 'none' | 'unknown'
    ) {
        super(code);
        this.name = 'ExternalAgentCommandError';
    }
}

export const externalAgentsAdministrationApiKey: InjectionKey<ExternalAgentsAdministrationApi> =
    Symbol('touchai.tools.external-agents.administration');

export function useExternalAgentsAdministrationApi(): ExternalAgentsAdministrationApi {
    const api = inject(externalAgentsAdministrationApiKey);
    if (!api) throw new ExternalAgentCommandError('EXTERNAL_AGENT_COMMAND_UNAVAILABLE', 'none');
    return api;
}
