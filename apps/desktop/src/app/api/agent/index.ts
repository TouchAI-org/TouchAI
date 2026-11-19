import { inject, type InjectionKey } from 'vue';

import type { AgentApi } from './contracts';

export type * from './contracts';

export const agentApiKey: InjectionKey<AgentApi> = Symbol('touchai.agent.api');

/** A window receives commands, never execution ownership or host disposal. */
export function useAgentApi(): AgentApi {
    const api = inject(agentApiKey);
    if (!api) throw new Error('AGENT_HOST_UNAVAILABLE');
    return api;
}
