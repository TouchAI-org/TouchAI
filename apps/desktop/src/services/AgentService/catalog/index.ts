// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * `catalog` 层负责只读目录能力。
 *
 * 它关心“系统里有哪些模型、provider、工具，以及如何实例化”，
 * 但不负责真正发起一次会话任务。
 */
export { getModel } from './models';
export { createProviderForModel, createProviderInstance } from './providers';
export { resolveToolDefinitions } from './tools';
