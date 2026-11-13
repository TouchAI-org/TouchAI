// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { AiCallRecord } from '@services/AgentService/contracts/protocol';

import type { CostBreakdown } from './cost';

/** 一次调用落库所需的完整信息 */
export interface PersistedCall {
    record: AiCallRecord;
    cost: CostBreakdown;
}

/** 一次调用的 `llm_call` 片段载荷 */
export interface LlmCallPartData {
    /** 所属回合；用于把调用账本按回合状态/模型筛选 */
    turnId: number | null;
    iteration: number;
    modelId: number;
    modelName: string;
    providerId: number | null;
    providerName: string;
    servedModel: string | null;
    usage: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        reasoningTokens: number;
    };
    timing: {
        ttftMs?: number;
        firstTextMs?: number;
        flowMs?: number;
        durationMs: number;
    };
    finishReason: string | null;
    errorMessage: string | null;
    toolCallsInStep: number;
    toolArgumentErrors: number;
    costMicros: number;
    priced: boolean;
    pricingModel: string | null;
    currency: string;
}

/**
 * 构造一次调用的 `llm_call` 片段 `data` 载荷。
 *
 * 单独抽出是为了可单测，且让 JSON 结构只有一处定义。
 */
export function buildLlmCallPartData(
    item: PersistedCall,
    turnId: number | null = null
): LlmCallPartData {
    const { record, cost } = item;
    return {
        turnId,
        iteration: record.iteration,
        modelId: record.modelId,
        modelName: record.modelName,
        providerId: record.providerId,
        providerName: record.providerName,
        servedModel: record.usage.servedModel ?? null,
        usage: {
            inputTokens: record.usage.inputTokens,
            outputTokens: record.usage.outputTokens,
            cacheReadTokens: record.usage.cacheReadTokens,
            cacheWriteTokens: record.usage.cacheWriteTokens,
            reasoningTokens: record.usage.reasoningTokens,
        },
        timing: record.timing,
        finishReason: record.finishReason ?? null,
        errorMessage: record.errorMessage ?? null,
        toolCallsInStep: record.toolCallsInStep,
        toolArgumentErrors: record.toolArgumentErrors,
        costMicros: cost.totalCostMicros,
        priced: cost.priced,
        pricingModel: cost.pricingModel,
        currency: cost.currency,
    };
}
