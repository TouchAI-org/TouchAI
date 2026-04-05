// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * `prompt` 层负责提示词装配。
 *
 * 它把 prompt 片段整理成快照，并映射成 provider 可消费的消息序列，
 * 但不直接执行模型请求。
 */
export { composePromptSnapshot } from './composer';
export { buildPromptTransportMessages } from './transport';
export type * from './types';
