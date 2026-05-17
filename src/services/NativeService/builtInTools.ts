import { invoke } from '@tauri-apps/api/core';

import type {
    BuiltInBashExecutionRequest,
    BuiltInBashExecutionResponse,
    BuiltInRipgrepExecutionRequest,
    BuiltInRipgrepExecutionResponse,
} from './types';

/**
 * 原生内置工具桥接层。
 */
export const builtInTools = {
    executeBash(request: BuiltInBashExecutionRequest): Promise<BuiltInBashExecutionResponse> {
        return invoke('built_in_tools_execute_bash', { request });
    },
    cancelBash(executionId: string): Promise<boolean> {
        return invoke('built_in_tools_cancel_bash', { executionId });
    },
    executeRipgrep(
        request: BuiltInRipgrepExecutionRequest
    ): Promise<BuiltInRipgrepExecutionResponse> {
        return invoke('built_in_tools_execute_ripgrep', { request });
    },
    cancelRipgrep(executionId: string): Promise<boolean> {
        return invoke('built_in_tools_cancel_ripgrep', { executionId });
    },
} as const;
