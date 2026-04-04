// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3.

import { McpManager } from './McpManager';

export * from './McpManager';
export * from './utils';

// 导出单例
export const mcpManager = new McpManager();
