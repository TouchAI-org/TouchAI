// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * `contracts` 层只放跨层共享的稳定契约。
 *
 * 这里定义的是 Agent 子系统内部共同使用的“语言”：
 * - 错误类型
 * - 请求 / 响应协议
 * - 工具调用与事件载荷
 *
 * 这些定义可以被多层同时依赖，但自身不承载运行流程。
 */
export { AiError, AiErrorCode } from './errors';
export type * from './protocol';
export type * from './tooling';
