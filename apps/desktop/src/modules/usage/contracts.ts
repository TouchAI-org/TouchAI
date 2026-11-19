import type { AiTiming, AiUsage } from '@touchai/models/contracts';

export interface UsageCall {
    iteration: number;
    modelId: number;
    modelName: string;
    providerId: number | null;
    providerName: string;
    usage: AiUsage;
    usageReported?: boolean;
    timing: AiTiming;
    finishReason?: string;
    errorMessage?: string;
    toolCallsInStep: number;
    toolArgumentErrors: number;
}

export interface ModelPricingTier {
    above: number;
    inputPerMillion: string;
    outputPerMillion: string;
    cacheReadPerMillion: string;
    cacheWritePerMillion: string;
    reasoningPerMillion: string;
}

export interface ModelPricing {
    modelId: string;
    inputPerMillion: string;
    outputPerMillion: string;
    cacheReadPerMillion: string;
    cacheWritePerMillion: string;
    reasoningPerMillion: string;
    currency: string;
    tiers: ModelPricingTier[];
}

export interface UsagePromptSnapshot {
    fragments: readonly { source: string; content: string }[];
    userPrompt: string;
    attachments: readonly { name: string; mimeType: string | null }[];
    systemPrompt: string;
}

export interface UsageMcpDefinition {
    name: string;
    description: string | null;
    input_schema: string;
}
export interface UsageBuiltinDefinition {
    tool_id: string;
    description: string | null;
}

export interface ConsumptionProjection {
    usage: AiUsage;
    costMicros: number;
    unpricedCalls: number;
    parts: { data: string; durationMs: number; ttftMs?: number }[];
}

export interface UsageThroughputSample {
    atMs: number;
    tokensPerSecond: number;
    totalTokens: number;
}

export interface UsageProgress {
    taskId: string;
    sessionId: number | null;
    modelName: string;
    outputTokens: number;
    tokensPerSecond: number | null;
    elapsedMs: number;
    ttftMs: number | null;
    estimatedCostMicros: number | null;
    streaming: boolean;
}
