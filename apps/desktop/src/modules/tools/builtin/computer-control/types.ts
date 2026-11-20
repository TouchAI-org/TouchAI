import type { ComputerUseGroups } from './capabilities';
export type { ComputerUseGroup, ComputerUseGroups } from './capabilities';

export type ComputerUseDriverId = 'cua-driver' | 'agent-desktop';

export type ComputerUseApproval = 'each' | 'session-window' | 'full-access';

export interface ComputerUseSettings {
    allowForeground: boolean;
    allowedApps: string[];
    approval: ComputerUseApproval;
    cursorVisible: boolean;
    enabled: boolean;
    maxImageDimension: number;
    recordingEnabled: boolean;
    telemetryEnabled: boolean;
}

export interface ComputerUseStatus {
    abiVersion: string | null;
    binary: string | null;
    driverVersion: string | null;
    installedSizeBytes?: number | null;
    error: string | null;
    installed: boolean;
}

export interface ComputerUseUpdate {
    current: string;
    error: string | null;
    latest: string | null;
    updateAvailable: boolean;
}

export interface ComputerUseInvocation {
    cancel: () => Promise<boolean>;
    executionId: string;
    result: Promise<Record<string, unknown>>;
}

/** Settings administration excludes task bindings, grants and arbitrary driver calls. */
export interface ComputerAdministration {
    isEnabled(): Promise<boolean>;
    setEnabled(enabled: boolean): Promise<void>;
    loadGroups(): Promise<ComputerUseGroups>;
    setGroupEnabled(
        group: import('./capabilities').ComputerUseGroup,
        enabled: boolean
    ): Promise<void>;
    loadDriver(): Promise<ComputerUseDriverId>;
    selectDriver(driver: ComputerUseDriverId): Promise<void>;
    loadDriverDirectory(): Promise<string>;
    saveDriverDirectory(directory: string): Promise<string>;
    loadSettings(): Promise<ComputerUseSettings>;
    saveSettings(patch: Partial<ComputerUseSettings>): Promise<ComputerUseSettings>;
    status(driver?: ComputerUseDriverId): Promise<ComputerUseStatus>;
    prepare(driver?: ComputerUseDriverId): Promise<ComputerUseStatus>;
    checkUpdate(driver?: ComputerUseDriverId): Promise<ComputerUseUpdate>;
    installUpdate(driver: ComputerUseDriverId, version: string): Promise<ComputerUseStatus>;
    remove(driver?: ComputerUseDriverId): Promise<void>;
    applySettings(): Promise<string[]>;
    setRecording(enabled: boolean): Promise<void>;
    setRecordingEnabled(enabled: boolean): Promise<ComputerUseSettings>;
    loadRecordingDirectory(): Promise<string>;
    saveRecordingDirectory(directory: string): Promise<string>;
}

export interface ComputerDriverTool {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
    capabilities?: string[];
    risk?: Record<string, unknown>;
}

export interface ComputerControlBinding {
    capture(): Promise<ComputerControlBinding>;
    loadDriver(): Promise<ComputerUseDriverId>;
    loadSettings(): Promise<ComputerUseSettings>;
    loadGroups(): Promise<ComputerUseGroups>;
    listTools(): Promise<ComputerDriverTool[]>;
    isEnabled(): Promise<boolean>;
    bindTask(signal: AbortSignal, stop: () => void): void;
    allowForSession(key: string): void;
    isAllowedForSession(key: string): boolean;
    startActivity(signal: AbortSignal): Promise<void>;
    endActivity(signal: AbortSignal): Promise<void>;
    pulseGlow(pointer?: { x: number; y: number }, signal?: AbortSignal): Promise<void>;
    execute(
        tool: string,
        args?: Record<string, unknown>,
        signal?: AbortSignal,
        activitySignal?: AbortSignal
    ): ComputerUseInvocation;
}
