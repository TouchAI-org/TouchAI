import { invoke } from '@tauri-apps/api/core';

import type { BuiltInBashExecutionRequest, BuiltInBashExecutionResponse } from './types';

/**
 * 原生内置工具桥接层。
 */
export const builtInTools = {
    executeBash(request: BuiltInBashExecutionRequest): Promise<BuiltInBashExecutionResponse> {
        return invoke('built_in_tools_execute_bash', { request });
    },
} as const;
