// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { getSettingValue, setSetting } from '@database/queries/settings';
import { getStatistic, setStatistic } from '@database/queries/statistics';
import { computerUse } from '@services/NativeService';

export type ComputerUseApproval = 'each' | 'session-window';

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

export interface ComputerUseStats {
    actions: number;
    avgDurationMs: number;
    denied: number;
    durationSamples: number;
    foregroundEscalations: number;
    successes: number;
}

export interface ComputerUseStatus {
    abiVersion: string | null;
    binary: string | null;
    driverVersion: string | null;
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

const SETTINGS_KEY = 'computer_use.settings';
const STATS_KEY = 'computer_use.stats';

export const DEFAULT_SETTINGS: ComputerUseSettings = {
    allowForeground: false,
    allowedApps: [],
    approval: 'each',
    cursorVisible: true,
    enabled: false,
    maxImageDimension: 1568,
    recordingEnabled: false,
    telemetryEnabled: false,
};

export const EMPTY_STATS: ComputerUseStats = {
    actions: 0,
    avgDurationMs: 0,
    denied: 0,
    durationSamples: 0,
    foregroundEscalations: 0,
    successes: 0,
};

function normalizeSettings(raw: unknown): ComputerUseSettings {
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_SETTINGS };
    const value = raw as Partial<ComputerUseSettings>;
    return {
        allowForeground: value.allowForeground ?? DEFAULT_SETTINGS.allowForeground,
        allowedApps: Array.isArray(value.allowedApps) ? value.allowedApps : [],
        approval: value.approval === 'session-window' ? 'session-window' : 'each',
        cursorVisible: value.cursorVisible ?? DEFAULT_SETTINGS.cursorVisible,
        enabled: value.enabled ?? DEFAULT_SETTINGS.enabled,
        maxImageDimension:
            typeof value.maxImageDimension === 'number' && value.maxImageDimension > 0
                ? Math.round(value.maxImageDimension)
                : DEFAULT_SETTINGS.maxImageDimension,
        recordingEnabled: value.recordingEnabled ?? DEFAULT_SETTINGS.recordingEnabled,
        telemetryEnabled: value.telemetryEnabled ?? DEFAULT_SETTINGS.telemetryEnabled,
    };
}

function normalizeStats(raw: unknown): ComputerUseStats {
    if (!raw || typeof raw !== 'object') return { ...EMPTY_STATS };
    const value = raw as Partial<ComputerUseStats>;
    return {
        actions: Number(value.actions) || 0,
        avgDurationMs: Number(value.avgDurationMs) || 0,
        denied: Number(value.denied) || 0,
        durationSamples: Number(value.durationSamples) || 0,
        foregroundEscalations: Number(value.foregroundEscalations) || 0,
        successes: Number(value.successes) || 0,
    };
}

export async function loadSettings(): Promise<ComputerUseSettings> {
    const stored = await getSettingValue({ key: SETTINGS_KEY });
    if (!stored) return { ...DEFAULT_SETTINGS };
    try {
        return normalizeSettings(JSON.parse(stored));
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
}

export async function saveSettings(
    patch: Partial<ComputerUseSettings>
): Promise<ComputerUseSettings> {
    const next = { ...(await loadSettings()), ...patch };
    await setSetting({ key: SETTINGS_KEY, value: JSON.stringify(next) });
    return next;
}

export async function loadStats(): Promise<ComputerUseStats> {
    const stored = await getStatistic({ key: STATS_KEY });
    if (!stored) return { ...EMPTY_STATS };
    try {
        return normalizeStats(JSON.parse(stored));
    } catch {
        return { ...EMPTY_STATS };
    }
}

export interface CompletedAction {
    denied?: boolean;
    durationMs?: number;
    foregroundEscalated?: boolean;
    succeeded: boolean;
}

/**
 * Aggregate counters live in the existing `statistics` table; per-action audit
 * stays in `built_in_tool_logs`. No new table and no schema change.
 */
export async function recordAction(action: CompletedAction): Promise<ComputerUseStats> {
    const current = await loadStats();
    const next: ComputerUseStats = {
        actions: current.actions + 1,
        denied: current.denied + (action.denied ? 1 : 0),
        durationSamples: current.durationSamples + (action.durationMs === undefined ? 0 : 1),
        foregroundEscalations: current.foregroundEscalations + (action.foregroundEscalated ? 1 : 0),
        successes: current.successes + (action.succeeded ? 1 : 0),
        avgDurationMs: current.avgDurationMs,
    };
    if (action.durationMs !== undefined) {
        const total = current.avgDurationMs * current.durationSamples + action.durationMs;
        next.avgDurationMs = Math.round(total / next.durationSamples);
    }
    await setStatistic({ key: STATS_KEY, value: JSON.stringify(next) });
    return next;
}

export async function status(): Promise<ComputerUseStatus> {
    const raw = await computerUse.status();
    return {
        abiVersion: raw.abi_version ?? null,
        binary: raw.binary ?? null,
        driverVersion: raw.driver_version ?? null,
        error: raw.error ?? null,
        installed: Boolean(raw.installed),
    };
}

export async function prepare(): Promise<ComputerUseStatus> {
    const raw = await computerUse.prepare();
    return {
        abiVersion: raw.abi_version ?? null,
        binary: raw.binary ?? null,
        driverVersion: raw.driver_version ?? null,
        error: raw.error ?? null,
        installed: Boolean(raw.installed),
    };
}

export async function checkUpdate(): Promise<ComputerUseUpdate> {
    const raw = await computerUse.checkUpdate();
    return {
        current: raw.current,
        error: raw.error,
        latest: raw.latest,
        updateAvailable: raw.update_available,
    };
}

/** Release the runtime and delete every installed driver version. */
export async function remove(): Promise<void> {
    await computerUse.remove();
}

/**
 * Push behaviour settings into the running driver.
 * Returns the driver's complaints; an empty list means everything applied.
 */
export async function applySettings(settings: ComputerUseSettings): Promise<string[]> {
    return computerUse.applySettings({
        cursorVisible: settings.cursorVisible,
        maxImageDimension: settings.maxImageDimension,
    });
}

/** Turn trajectory recording on or off; recordings stay in the app cache. */
export async function setRecording(enabled: boolean): Promise<void> {
    await computerUse.setRecording(enabled);
}

/**
 * Start one driver call. Callers own approval; this only wires cancellation.
 */
export function execute(tool: string, args: Record<string, unknown> = {}): ComputerUseInvocation {
    const executionId = crypto.randomUUID();
    return {
        executionId,
        result: computerUse.call({ arguments: args, executionId, tool }),
        cancel: () => computerUse.cancel(executionId),
    };
}

/**
 * Approvals remembered for this app session, keyed by action and target.
 * In-memory on purpose: quitting TouchAI forgets every grant.
 */
const sessionApprovals = new Set<string>();

export function targetKey(action: string, pid?: unknown, windowId?: unknown): string {
    return `${action}:${String(pid ?? '-')}:${String(windowId ?? '-')}`;
}

export function allowForSession(key: string): void {
    sessionApprovals.add(key);
}

export function isAllowedForSession(key: string): boolean {
    return sessionApprovals.has(key);
}

export function clearSessionApprovals(): void {
    sessionApprovals.clear();
}

export const computerUseService = {
    allowForSession,
    applySettings,
    checkUpdate,
    clearSessionApprovals,
    execute,
    isAllowedForSession,
    loadSettings,
    loadStats,
    prepare,
    recordAction,
    remove,
    saveSettings,
    setRecording,
    status,
    targetKey,
} as const;
