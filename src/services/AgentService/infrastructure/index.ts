// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * `infrastructure` 层负责底层适配实现。
 *
 * 这里放 provider、MCP、附件、设置等“怎么接外部系统”的代码，
 * 但不在这里编排会话级或任务级流程。
 */
export * from './attachments';
export * from './mcp';
export * from './modelMetadata';
export * from './providers';
export * from './settings';
