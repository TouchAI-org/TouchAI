import { invoke } from './invoke';
import type { ComputerUseDriverStatus, ComputerUseUpdateInfo } from './types';

export interface ComputerUseInvokeRequest {
    arguments: Record<string, unknown>;
    executionId: string;
    tool: string;
}

/**
 * Native computer use bridge. The driver runs in-process through the C ABI,
 * so there is no child process to supervise here.
 */
export const computerUse = {
    status(): Promise<ComputerUseDriverStatus> {
        return invoke('computer_use_status');
    },
    prepare(): Promise<ComputerUseDriverStatus> {
        return invoke('computer_use_prepare');
    },
    call(request: ComputerUseInvokeRequest): Promise<Record<string, unknown>> {
        return invoke('computer_use_invoke', { ...request });
    },
    cancel(executionId: string): Promise<boolean> {
        return invoke('computer_use_cancel', { executionId });
    },
    checkUpdate(): Promise<ComputerUseUpdateInfo> {
        return invoke('computer_use_check_update');
    },
    remove(): Promise<boolean> {
        return invoke('computer_use_remove');
    },
    applySettings(request: {
        cursorVisible?: boolean;
        maxImageDimension?: number;
    }): Promise<string[]> {
        return invoke('computer_use_apply_settings', { ...request });
    },
    setRecording(enabled: boolean): Promise<boolean> {
        return invoke('computer_use_set_recording', { enabled });
    },
    shutdown(): Promise<void> {
        return invoke('computer_use_shutdown');
    },
} as const;
