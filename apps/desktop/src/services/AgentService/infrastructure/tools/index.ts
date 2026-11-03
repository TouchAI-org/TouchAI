// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * 平台工具分发的公开入口。
 *
 * 调用方只需要 `dispatchToolCall` 与它的请求/结果类型：把一个模型返回的工具调用
 * 送到正确的适配器（内置工具或 MCP），拿回统一的结果。具体适配器是内部实现，
 * 不从这里导出，避免调用方绕过分发决策直接驱动某一个执行路径。
 */
export { dispatchToolCall } from './dispatcher';
export type { ToolCallContext, ToolDispatchRequest, ToolDispatchResult } from './types';
