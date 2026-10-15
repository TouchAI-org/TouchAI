// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { ThinkingLevelMap } from '../../../contracts/reasoning';

export { encodeReasoning } from './formats';
export {
    getOpenAiSupportedLevels,
    getOpenAiThinkingLevelMap,
    isOpenAiGpt6SolOrLuna,
} from './openaiModels';
export { resolveReasoning } from './resolver';
export type {
    ChatTemplateKwargValue,
    ReasoningEncoderResult,
    ReasoningResolution,
    ResolveReasoningInput,
    ThinkingCompat,
} from './types';

/**
 * DeepSeek 官方能力：`thinking` 开关 + effort low/high/max。
 *
 * 对齐 Pi 的 deepseek catalog：`off` 省略（用 `thinking: { type: 'disabled' }` 关闭思考），
 * low/high/max 走 `reasoningEffort`，其余档位为 null。
 */
export const DEEPSEEK_THINKING_LEVEL_MAP: ThinkingLevelMap = {
    minimal: null,
    low: 'low',
    medium: null,
    high: 'high',
    xhigh: null,
    max: 'max',
};
