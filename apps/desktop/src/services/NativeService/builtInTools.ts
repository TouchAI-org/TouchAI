import { invoke } from '@tauri-apps/api/core';

import type {
    BuiltInBashExecutionRequest,
    BuiltInBashExecutionResponse,
    WebBrowseNativeRequest,
    WebBrowseNativeResponse,
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
    webBrowse(request: WebBrowseNativeRequest): Promise<WebBrowseNativeResponse> {
        return invoke('built_in_tools_web_browse', { request });
    },
} as const;
