// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { findBuiltInToolByToolId, updateBuiltInTool } from '@database/queries/builtInTools';
import { getSettingValue, getSettingValues, setSetting } from '@database/queries/settings';
import { computerUse, paths } from '@services/NativeService';
import type { ComputerUseDriverId } from '@services/NativeService/computerUse';
import { log } from '@services/ObservabilityService';
import { join } from '@tauri-apps/api/path';

import { getLocale } from '@/i18n';
import { AppEvent, eventService } from '@/services/EventService';

import { COMPUTER_USE_GROUPS, type ComputerUseGroup, type ComputerUseGroups } from './capabilities';

export async function isEnabled(): Promise<boolean> {
    return (await findBuiltInToolByToolId('computer_use'))?.enabled === 1;
}

export async function setEnabled(enabled: boolean): Promise<void> {
    const tool = await findBuiltInToolByToolId('computer_use');
    if (!tool) throw new Error('computer_use tool is not registered');
    if (!(await updateBuiltInTool(tool.id, { enabled: enabled ? 1 : 0 }))) {
        throw new Error('computer_use enabled state could not be saved');
    }
    clearSessionApprovals();
    if (!enabled) await computerUse.cancelAll();
}

export async function loadGroups(): Promise<ComputerUseGroups> {
    const stored = await getSettingValues({
        keys: COMPUTER_USE_GROUPS.map((group) => `computer_use.group.${group}`),
    });
    return Object.fromEntries(
        COMPUTER_USE_GROUPS.map((group) => [
            group,
            stored[`computer_use.group.${group}`] !== 'false',
        ])
    );
}

export async function setGroupEnabled(group: ComputerUseGroup, enabled: boolean): Promise<void> {
    await setSetting({ key: `computer_use.group.${group}`, value: String(enabled) });
    clearSessionApprovals();
    if (!enabled) await computerUse.cancelAll();
}

let catalog: ReturnType<typeof computerUse.listTools> | undefined;
let catalogDriver: ComputerUseDriverId | undefined;
const configuredSessions = new Map<string, { expiresAt: number; ready: Promise<void> }>();
export async function listTools(): ReturnType<typeof computerUse.listTools> {
    const driver = await loadDriver();
    if (!catalog || catalogDriver !== driver) {
        catalogDriver = driver;
        catalog = computerUse
            .listTools(driver)
            .then((tools) => {
                if (tools.length === 0) catalog = undefined;
                return tools;
            })
            .catch((error: unknown) => {
                catalog = undefined;
                throw error;
            });
    }
    return catalog;
}

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

const SETTINGS_KEY = 'computer_use.settings';
const RECORDING_DIRECTORY_KEY = 'computer_use.recording_directory';
const DRIVER_KEY = 'computer_use.driver';
const DRIVER_DIRECTORY_KEY = 'computer_use.driver_directory';
let observedDriverDirectory: string | undefined;

export async function loadDriver(): Promise<ComputerUseDriverId> {
    const values = await getSettingValues({ keys: [DRIVER_KEY, DRIVER_DIRECTORY_KEY] });
    const directory = values[DRIVER_DIRECTORY_KEY] ?? '';
    if (observedDriverDirectory !== directory) {
        observedDriverDirectory = directory;
        catalog = undefined;
        configuredSessions.clear();
        clearSessionApprovals();
    }
    const stored = values[DRIVER_KEY];
    return stored === 'agent-desktop' ? stored : 'cua-driver';
}

export async function selectDriver(driver: ComputerUseDriverId): Promise<void> {
    if (driver !== 'cua-driver' && driver !== 'agent-desktop') throw new Error('unknown_driver');
    const availability = await status(driver);
    if (!availability.installed || availability.error) {
        throw new Error(availability.error || 'computer_use_driver_unavailable');
    }
    if (driver === (await loadDriver())) return;
    await computerUse.cancelAll();
    await computerUse.shutdown();
    await setSetting({ key: DRIVER_KEY, value: driver });
    catalog = undefined;
    configuredSessions.clear();
    clearSessionApprovals();
}

export async function loadDriverDirectory(): Promise<string> {
    return computerUse.driverDirectory();
}

export async function saveDriverDirectory(directory: string): Promise<string> {
    await computerUse.cancelAll();
    try {
        const saved = await computerUse.setDriverDirectory(directory);
        try {
            await restoreRuntimeSettings();
        } catch (error) {
            log.warn(
                '[ComputerUse] Driver storage moved; runtime settings were not reapplied',
                error
            );
        }
        return saved;
    } finally {
        catalog = undefined;
        configuredSessions.clear();
        clearSessionApprovals();
    }
}

/**
 * Relocation stops both runtimes, so the driver comes back with defaults.
 * Re-apply what the user configured before the move, otherwise recording and
 * screenshot limits silently revert until the next manual change.
 */
async function restoreRuntimeSettings(): Promise<void> {
    const settings = await loadSettings();
    const driver = await loadDriver();
    const availability = await status(driver);
    if (!availability.installed || availability.error) return;
    if (driver === 'cua-driver') await applySettings(settings);
    if (settings.recordingEnabled) await setRecording(true);
}

export const DEFAULT_SETTINGS: ComputerUseSettings = {
    allowForeground: true,
    allowedApps: [],
    approval: 'each',
    cursorVisible: true,
    enabled: false,
    maxImageDimension: 1568,
    recordingEnabled: false,
    telemetryEnabled: false,
};

function normalizeSettings(raw: unknown): ComputerUseSettings {
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_SETTINGS };
    const value = raw as Partial<ComputerUseSettings>;
    return {
        allowForeground: value.allowForeground ?? DEFAULT_SETTINGS.allowForeground,
        allowedApps: Array.isArray(value.allowedApps) ? value.allowedApps : [],
        approval:
            value.approval === 'session-window' || value.approval === 'full-access'
                ? value.approval
                : 'each',
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

export async function loadSettings(): Promise<ComputerUseSettings> {
    const stored = await getSettingValue({ key: SETTINGS_KEY });
    if (!stored) return { ...DEFAULT_SETTINGS };
    try {
        return normalizeSettings(JSON.parse(stored));
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
}

let pendingSettingsSave: Promise<void> = Promise.resolve();

export function saveSettings(patch: Partial<ComputerUseSettings>): Promise<ComputerUseSettings> {
    const changes = { ...patch };
    const saved = pendingSettingsSave.then(async () => {
        const next = { ...(await loadSettings()), ...changes };
        await setSetting({ key: SETTINGS_KEY, value: JSON.stringify(next) });
        configuredSessions.clear();
        return next;
    });
    pendingSettingsSave = saved.then(
        () => undefined,
        () => undefined
    );
    return saved;
}

export async function status(driver?: ComputerUseDriverId): Promise<ComputerUseStatus> {
    const raw = await computerUse.status(driver ?? (await loadDriver()));
    return {
        abiVersion: raw.abi_version ?? null,
        binary: raw.binary ?? null,
        driverVersion: raw.driver_version ?? null,
        installedSizeBytes: raw.installed_size_bytes ?? null,
        error: raw.error ?? null,
        installed: Boolean(raw.installed),
    };
}

export async function prepare(driver?: ComputerUseDriverId): Promise<ComputerUseStatus> {
    catalog = undefined;
    configuredSessions.clear();
    const raw = await computerUse.prepare(driver ?? (await loadDriver()));
    return {
        abiVersion: raw.abi_version ?? null,
        binary: raw.binary ?? null,
        driverVersion: raw.driver_version ?? null,
        installedSizeBytes: raw.installed_size_bytes ?? null,
        error: raw.error ?? null,
        installed: Boolean(raw.installed),
    };
}

const activities = new WeakMap<
    AbortSignal,
    {
        id: string;
        ready: Promise<void>;
        onAbort: () => void;
        unlisten?: () => void;
        sessions: Map<string, string>;
    }
>();
const finishedActivities = new WeakSet<AbortSignal>();
const taskStops = new WeakMap<AbortSignal, () => void>();

export function bindTask(signal: AbortSignal, stop: () => void): void {
    taskStops.set(signal, stop);
}

export function startActivity(signal: AbortSignal): Promise<void> {
    if (signal.aborted || finishedActivities.has(signal)) return Promise.resolve();
    const existing = activities.get(signal);
    if (existing) return existing.ready;
    const id = crypto.randomUUID();
    const onAbort = () => {
        void endActivity(signal).catch((error) => {
            log.warn('[ComputerUse] Failed to release activity feedback:', error);
        });
    };
    const activity = {
        id,
        ready: Promise.resolve(),
        onAbort,
        sessions: new Map<string, string>(),
        unlisten: undefined as (() => void) | undefined,
    };
    const ready = eventService
        .on(AppEvent.COMPUTER_USE_STOPPED, (ids) => {
            if (!ids.includes(id)) return;
            taskStops.get(signal)?.();
            onAbort();
        })
        .then(async (unlisten) => {
            activity.unlisten = unlisten;
            await computerUse.setActivity(id, true, getLocale());
        })
        .catch((error: unknown) => {
            if (activities.get(signal)?.id === id) activities.delete(signal);
            activity.unlisten?.();
            signal.removeEventListener('abort', onAbort);
            throw error;
        });
    activity.ready = ready;
    activities.set(signal, activity);
    signal.addEventListener('abort', onAbort, { once: true });
    return ready;
}

export async function endActivity(signal: AbortSignal): Promise<void> {
    finishedActivities.add(signal);
    const activity = activities.get(signal);
    if (!activity) return;
    activities.delete(signal);
    signal.removeEventListener('abort', activity.onAbort);
    await activity.ready;
    activity.unlisten?.();
    await computerUse.setActivity(activity.id, false);
    for (const session of activity.sessions.values()) {
        for (const key of configuredSessions.keys()) {
            if (key.includes(session)) configuredSessions.delete(key);
        }
    }
}

export async function pulseGlow(
    pointer?: { x: number; y: number },
    signal?: AbortSignal
): Promise<void> {
    if (!signal) {
        await computerUse.pulseGlow(pointer);
        return;
    }
    const activity = activities.get(signal);
    if (!activity || signal.aborted) return;
    await activity.ready;
    if (activities.get(signal) === activity && !signal.aborted) {
        await computerUse.pulseGlow(pointer, activity.id);
    }
}

export async function checkUpdate(driver?: ComputerUseDriverId): Promise<ComputerUseUpdate> {
    const raw = await computerUse.checkUpdate(driver ?? (await loadDriver()));
    return {
        current: raw.current,
        error: raw.error,
        latest: raw.latest,
        updateAvailable: raw.update_available,
    };
}

export async function installUpdate(
    driver: ComputerUseDriverId,
    version: string
): Promise<ComputerUseStatus> {
    await computerUse.cancelAll();
    configuredSessions.clear();
    clearSessionApprovals();
    catalog = undefined;
    const raw = await computerUse.installUpdate(driver, version);
    return {
        abiVersion: raw.abi_version ?? null,
        binary: raw.binary ?? null,
        driverVersion: raw.driver_version ?? null,
        installedSizeBytes: raw.installed_size_bytes ?? null,
        error: raw.error ?? null,
        installed: Boolean(raw.installed),
    };
}

/** Release the runtime and delete every installed driver version. */
export async function remove(driver?: ComputerUseDriverId): Promise<void> {
    const selected = await loadDriver();
    const removed = driver ?? selected;
    await computerUse.remove(removed);
    catalog = undefined;
    configuredSessions.clear();
    clearSessionApprovals();
    if (removed !== selected) return;
    const remaining = removed === 'cua-driver' ? 'agent-desktop' : 'cua-driver';
    const availability = await status(remaining);
    if (availability.installed && !availability.error) await selectDriver(remaining);
}

/**
 * Push behaviour settings into the running driver.
 * Returns the driver's complaints; an empty list means everything applied.
 */
export async function applySettings(
    settings: ComputerUseSettings,
    session?: string,
    activityId?: string
): Promise<string[]> {
    if ((await loadDriver()) === 'agent-desktop') return [];
    const errors: string[] = [];
    for (const [tool, values] of [
        ['set_config', { max_image_dimension: settings.maxImageDimension }],
        ['set_agent_cursor_enabled', { enabled: false }],
    ] as const) {
        try {
            const result = await computerUse.call({
                tool,
                arguments: { ...values, ...(session ? { session } : {}) },
                executionId: crypto.randomUUID(),
                fullAccess: settings.approval === 'full-access',
                activityId,
            });
            if (result.isError === true) errors.push(`${tool}: ${JSON.stringify(result.content)}`);
        } catch (error) {
            errors.push(`${tool}: ${String(error)}`);
        }
    }
    return errors;
}

async function ensureSessionSettings(
    settings: ComputerUseSettings,
    session?: string,
    activityId?: string
): Promise<void> {
    const key = JSON.stringify([settings.approval === 'full-access', session ?? '']);
    const cached = configuredSessions.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.ready;
    if (configuredSessions.size >= 32) configuredSessions.clear();
    const ready = applySettings(settings, session, activityId).then((errors) => {
        if (errors.length > 0) {
            configuredSessions.delete(key);
            throw new Error(errors.join('\n'));
        }
    });
    configuredSessions.set(key, { expiresAt: Date.now() + 30 * 60 * 1000, ready });
    return ready;
}

export async function setRecording(enabled: boolean): Promise<void> {
    const driver = await loadDriver();
    const directory = enabled ? await loadRecordingDirectory() : undefined;
    if (driver === 'cua-driver') await computerUse.setRecording(enabled, directory);
    else await computerUse.setRecording(enabled, directory, driver);
}

export async function loadRecordingDirectory(): Promise<string> {
    const driver = await loadDriver();
    const stored = await getSettingValue({ key: recordingDirectoryKey(driver) });
    return (
        stored ||
        (await join(await paths.getAppDirectoryPath('CACHE'), 'computer-use-trajectories', driver))
    );
}

export async function saveRecordingDirectory(directory: string): Promise<string> {
    const driver = await loadDriver();
    const leaf = directory
        .replace(/[\\/]+$/, '')
        .split(/[\\/]/)
        .pop();
    if (leaf !== driver) directory = await join(directory, driver);
    const key = recordingDirectoryKey(driver);
    const previous = await getSettingValue({ key });
    if (directory === previous) return directory;
    const settings = await loadSettings();
    await setSetting({ key, value: directory });
    try {
        if (settings.recordingEnabled) await setRecording(true);
    } catch (error) {
        await setSetting({ key, value: previous ?? '' });
        throw error;
    }
    return loadRecordingDirectory();
}

function recordingDirectoryKey(driver: ComputerUseDriverId): string {
    return driver === 'cua-driver'
        ? RECORDING_DIRECTORY_KEY
        : `${RECORDING_DIRECTORY_KEY}.${driver}`;
}

/**
 * Start one driver call. Callers own approval; this only wires cancellation.
 */
export function execute(
    tool: string,
    args: Record<string, unknown> = {},
    signal?: AbortSignal
): ComputerUseInvocation {
    const executionId = crypto.randomUUID();
    let cancelled = false;
    return {
        executionId,
        result: loadSettings().then(async (settings) => {
            const driver = await loadDriver();
            if (cancelled || signal?.aborted || (signal && finishedActivities.has(signal)))
                throw new Error('computer use cancelled');
            const activity = signal ? activities.get(signal) : undefined;
            if (activity) {
                await activity.ready;
                if (cancelled || signal?.aborted || (signal && finishedActivities.has(signal)))
                    throw new Error('computer use cancelled');
                if (driver === 'cua-driver') {
                    const requested = typeof args.session === 'string' ? args.session : '';
                    let session = [...activity.sessions.values()].includes(requested)
                        ? requested
                        : activity.sessions.get(requested);
                    if (!session) {
                        if (activity.sessions.size >= 16)
                            throw new Error('too many computer use sessions in one task');
                        session = `${activity.id}-${activity.sessions.size + 1}`;
                        activity.sessions.set(requested, session);
                    }
                    args = { ...args, session };
                }
            }
            if (settings.recordingEnabled) await setRecording(true);
            if (
                driver === 'cua-driver' &&
                ![
                    'start_session',
                    'end_session',
                    'get_session',
                    'list_sessions',
                    'check_permissions',
                    'health_report',
                ].includes(tool)
            ) {
                await ensureSessionSettings(
                    settings,
                    typeof args.session === 'string' ? args.session : undefined,
                    activity?.id
                );
            }
            if (cancelled || signal?.aborted || (signal && finishedActivities.has(signal)))
                throw new Error('computer use cancelled');
            const result = await computerUse.call({
                driver,
                activityId: activity?.id,
                cursorVisible: settings.cursorVisible,
                allowForeground: settings.allowForeground,
                arguments: args,
                executionId,
                tool,
                fullAccess: settings.approval === 'full-access',
            });
            if (tool === 'end_session') configuredSessions.clear();
            return result;
        }),
        cancel: () => {
            cancelled = true;
            return computerUse.cancel(executionId);
        },
    };
}

/**
 * Approvals remembered for this app session, keyed by target window.
 * In-memory on purpose: quitting TouchAI forgets every grant.
 */
const sessionApprovals = new Set<string>();

export function targetKey(pid?: unknown, windowId?: unknown): string {
    return `${String(pid ?? '-')}:${String(windowId ?? '-')}`;
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
    bindTask,
    loadDriverDirectory,
    saveDriverDirectory,
    loadDriver,
    selectDriver,
    isEnabled,
    setEnabled,
    loadGroups,
    setGroupEnabled,
    listTools,
    allowForSession,
    applySettings,
    checkUpdate,
    installUpdate,
    clearSessionApprovals,
    execute,
    startActivity,
    endActivity,
    isAllowedForSession,
    loadSettings,
    loadRecordingDirectory,
    prepare,
    pulseGlow,
    remove,
    saveSettings,
    saveRecordingDirectory,
    setRecording,
    status,
    targetKey,
} as const;
