import type { ExternalAgentPollingOptions } from './contracts';

export const EXTERNAL_AGENT_CARD_MAX_BYTES = 1024 * 1024;
export const EXTERNAL_AGENT_DISCOVERY_TIMEOUT_MS = 15_000;
export const EXTERNAL_AGENT_FINAL_TEXT_MAX_BYTES = 2 * 1024 * 1024;
export const EXTERNAL_AGENT_INVOCATION_TIMEOUT_MS = 120_000;
export const EXTERNAL_AGENT_CANCEL_TIMEOUT_MS = 2_000;
export const EXTERNAL_AGENT_POLLING_DEFAULTS: ExternalAgentPollingOptions = {
    initialDelayMs: 250,
    maxDelayMs: 4_000,
    timeoutMs: 120_000,
};
