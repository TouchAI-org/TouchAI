import { invoke } from './invoke';
import type { ComputerUseDriverStatus, ComputerUseUpdateInfo } from './types';

export type ComputerUseDriverId = 'cua-driver' | 'agent-desktop';

export interface ComputerUseInvokeRequest {
    arguments: Record<string, unknown>;
    executionId: string;
    tool: string;
    fullAccess?: boolean;
    driver?: ComputerUseDriverId;
    allowForeground?: boolean;
    activityId?: string;
    cursorVisible?: boolean;
}

export interface ComputerUseFeedback {
    generation: number;
    activities: { id: string; ordinal: number; pointer: { x: number; y: number } | null }[];
    banner: { x: number; y: number } | null;
    locale: string;
}

export interface ComputerUseDriverTool {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
    capabilities?: string[];
    risk?: Record<string, unknown>;
}

export const computerUse = {
    driverDirectory(): Promise<string> {
        return invoke('computer_use_driver_directory');
    },
    setDriverDirectory(directory: string): Promise<string> {
        return invoke('computer_use_set_driver_directory', { directory });
    },
    listTools(driver?: ComputerUseDriverId): Promise<ComputerUseDriverTool[]> {
        return invoke('computer_use_list_tools', { driver });
    },
    status(driver?: ComputerUseDriverId): Promise<ComputerUseDriverStatus> {
        return invoke('computer_use_status', { driver });
    },
    prepare(driver?: ComputerUseDriverId): Promise<ComputerUseDriverStatus> {
        return invoke('computer_use_prepare', { driver });
    },
    setActivity(activityId: string, active: boolean, locale?: string): Promise<void> {
        return invoke('computer_use_glow_set_active', { activityId, active, locale });
    },
    feedback(): Promise<ComputerUseFeedback> {
        return invoke('computer_use_glow_snapshot');
    },
    pulseGlow(pointer?: { x: number; y: number }, activityId?: string): Promise<void> {
        return invoke('computer_use_glow_pulse', { pointer, activityId });
    },
    cursorPosition(): Promise<{ x: number; y: number }> {
        return invoke('computer_use_cursor_position');
    },
    call(request: ComputerUseInvokeRequest): Promise<Record<string, unknown>> {
        return invoke('computer_use_invoke', { ...request });
    },
    cancel(executionId: string): Promise<boolean> {
        return invoke('computer_use_cancel', { executionId });
    },
    cancelAll(): Promise<number> {
        return invoke('computer_use_cancel_all');
    },
    checkUpdate(driver?: ComputerUseDriverId): Promise<ComputerUseUpdateInfo> {
        return invoke('computer_use_check_update', { driver });
    },
    installUpdate(driver: ComputerUseDriverId, version: string): Promise<ComputerUseDriverStatus> {
        return invoke('computer_use_install_update', { driver, version });
    },
    remove(driver?: ComputerUseDriverId): Promise<boolean> {
        return invoke('computer_use_remove', { driver });
    },
    applySettings(request: {
        cursorVisible?: boolean;
        maxImageDimension?: number;
    }): Promise<string[]> {
        return invoke('computer_use_apply_settings', { ...request });
    },
    setRecording(
        enabled: boolean,
        outputDir?: string,
        driver?: ComputerUseDriverId
    ): Promise<boolean> {
        return invoke('computer_use_set_recording', { enabled, outputDir, driver });
    },
    shutdown(): Promise<void> {
        return invoke('computer_use_shutdown');
    },
} as const;
