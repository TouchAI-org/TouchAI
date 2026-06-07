import { invoke } from '@tauri-apps/api/core';

import type {
    BuiltInBashExecutionRequest,
    BuiltInBashExecutionResponse,
    ComputerActionRequest,
    ComputerActionResponse,
    ComputerObservationRequest,
    ComputerObservationResponse,
    ComputerSessionRequest,
    ComputerSessionResponse,
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
    startComputerSession(request: ComputerSessionRequest): Promise<ComputerSessionResponse> {
        return invoke('built_in_tools_computer_session', { request });
    },
    observeComputer(request: ComputerObservationRequest): Promise<ComputerObservationResponse> {
        return invoke('built_in_tools_computer_observe', { request });
    },
    executeComputerAction(request: ComputerActionRequest): Promise<ComputerActionResponse> {
        return invoke('built_in_tools_computer_act', { request });
    },
} as const;
