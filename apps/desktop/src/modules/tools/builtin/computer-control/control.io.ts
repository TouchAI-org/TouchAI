// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { findBuiltInToolByToolId, updateBuiltInTool } from '@database/queries/builtInTools';
import { getSettingValue, getSettingValues, setSetting } from '@database/queries/settings';

import { join } from '@/platform/files';
import { computerUse, paths } from '@/platform/native';

import {
    COMPUTER_USE_GROUPS,
    type ComputerUseGroup,
    type ComputerUseGroups,
    disabledToolGroup,
} from './capabilities';
import { DEFAULT_SETTINGS, normalizeSettings } from './configuration';
import type {
    ComputerControlBinding,
    ComputerUseDriverId,
    ComputerUseInvocation,
    ComputerUseSettings,
    ComputerUseStatus,
    ComputerUseUpdate,
} from './types';

export function createComputerControl(input: {
    locale(): string;
    onStopped(listener: (ids: string[]) => void): Promise<() => void>;
    warn(message: string, error: unknown): void;
}) {
    const getLocale = input.locale.bind(input);
    const log = { warn: input.warn.bind(input) };
    const activitySignals = new Set<AbortSignal>();
    const invocations = new Set<ComputerUseInvocation>();
    let disposed = false;
    let driverGeneration = 0;
    async function isEnabled(): Promise<boolean> {
        return (await findBuiltInToolByToolId('computer_use'))?.enabled === 1;
    }

    async function setEnabled(enabled: boolean): Promise<void> {
        const tool = await findBuiltInToolByToolId('computer_use');
        if (!tool) throw new Error('computer_use tool is not registered');
        if (!(await updateBuiltInTool(tool.id, { enabled: enabled ? 1 : 0 }))) {
            throw new Error('computer_use enabled state could not be saved');
        }
        clearSessionApprovals();
        if (!enabled) await computerUse.cancelAll();
    }

    async function loadGroups(): Promise<ComputerUseGroups> {
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

    async function setGroupEnabled(group: ComputerUseGroup, enabled: boolean): Promise<void> {
        await setSetting({ key: `computer_use.group.${group}`, value: String(enabled) });
        clearSessionApprovals();
        if (!enabled) await computerUse.cancelAll();
    }

    let catalog: ReturnType<typeof computerUse.listTools> | undefined;
    let catalogDriver: ComputerUseDriverId | undefined;
    const configuredSessions = new Map<string, { expiresAt: number; ready: Promise<void> }>();
    async function listTools(): ReturnType<typeof computerUse.listTools> {
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

    const SETTINGS_KEY = 'computer_use.settings';
    const RECORDING_DIRECTORY_KEY = 'computer_use.recording_directory';
    const DRIVER_KEY = 'computer_use.driver';
    const DRIVER_DIRECTORY_KEY = 'computer_use.driver_directory';
    let observedDriverDirectory: string | undefined;
    let observedDriver: ComputerUseDriverId | undefined;

    async function loadDriver(): Promise<ComputerUseDriverId> {
        const values = await getSettingValues({ keys: [DRIVER_KEY, DRIVER_DIRECTORY_KEY] });
        const directory = values[DRIVER_DIRECTORY_KEY] ?? '';
        const driver = values[DRIVER_KEY] === 'agent-desktop' ? 'agent-desktop' : 'cua-driver';
        if (observedDriverDirectory !== directory || observedDriver !== driver) {
            driverGeneration++;
            observedDriverDirectory = directory;
            observedDriver = driver;
            catalog = undefined;
            configuredSessions.clear();
            clearSessionApprovals();
        }
        return driver;
    }

    async function selectDriver(driver: ComputerUseDriverId): Promise<void> {
        if (driver !== 'cua-driver' && driver !== 'agent-desktop')
            throw new Error('unknown_driver');
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

    async function loadDriverDirectory(): Promise<string> {
        return computerUse.driverDirectory();
    }

    async function saveDriverDirectory(directory: string): Promise<string> {
        driverGeneration++;
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

    async function loadSettings(): Promise<ComputerUseSettings> {
        const stored = await getSettingValue({ key: SETTINGS_KEY });
        if (!stored) return { ...DEFAULT_SETTINGS };
        try {
            return normalizeSettings(JSON.parse(stored));
        } catch {
            return { ...DEFAULT_SETTINGS };
        }
    }

    let pendingSettingsSave: Promise<void> = Promise.resolve();

    function saveSettings(patch: Partial<ComputerUseSettings>): Promise<ComputerUseSettings> {
        const changes = { ...patch };
        const saved = pendingSettingsSave.then(async () => {
            const next = { ...(await loadSettings()), ...changes };
            await setSetting({ key: SETTINGS_KEY, value: JSON.stringify(next) });
            configuredSessions.clear();
            if (changes.approval !== undefined) clearSessionApprovals();
            return next;
        });
        pendingSettingsSave = saved.then(
            () => undefined,
            () => undefined
        );
        return saved;
    }

    async function status(driver?: ComputerUseDriverId): Promise<ComputerUseStatus> {
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

    async function prepare(driver?: ComputerUseDriverId): Promise<ComputerUseStatus> {
        driverGeneration++;
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

    function bindTask(signal: AbortSignal, stop: () => void): void {
        taskStops.set(signal, stop);
    }

    function startActivity(signal: AbortSignal): Promise<void> {
        if (disposed || signal.aborted || finishedActivities.has(signal)) return Promise.resolve();
        activitySignals.add(signal);
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
        const ready = input
            .onStopped((ids) => {
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

    async function endActivity(signal: AbortSignal): Promise<void> {
        activitySignals.delete(signal);
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

    async function pulseGlow(
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

    async function checkUpdate(driver?: ComputerUseDriverId): Promise<ComputerUseUpdate> {
        const raw = await computerUse.checkUpdate(driver ?? (await loadDriver()));
        return {
            current: raw.current,
            error: raw.error,
            latest: raw.latest,
            updateAvailable: raw.update_available,
        };
    }

    async function installUpdate(
        driver: ComputerUseDriverId,
        version: string
    ): Promise<ComputerUseStatus> {
        driverGeneration++;
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
    async function remove(driver?: ComputerUseDriverId): Promise<void> {
        driverGeneration++;
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
    async function applySettings(
        settings: ComputerUseSettings,
        session?: string,
        activityId?: string,
        driver?: ComputerUseDriverId,
        check: () => Promise<void> = async () => {}
    ): Promise<string[]> {
        const selected = driver ?? (await loadDriver());
        if (selected === 'agent-desktop') return [];
        const errors: string[] = [];
        for (const [tool, values] of [
            ['set_config', { max_image_dimension: settings.maxImageDimension }],
            ['set_agent_cursor_enabled', { enabled: false }],
        ] as const) {
            try {
                await check();
                const result = await computerUse.call({
                    driver: selected,
                    tool,
                    arguments: { ...values, ...(session ? { session } : {}) },
                    executionId: crypto.randomUUID(),
                    fullAccess: settings.approval === 'full-access',
                    activityId,
                });
                if (result.isError === true)
                    errors.push(`${tool}: ${JSON.stringify(result.content)}`);
            } catch (error) {
                errors.push(`${tool}: ${String(error)}`);
            }
        }
        return errors;
    }

    async function ensureSessionSettings(
        settings: ComputerUseSettings,
        session?: string,
        activityId?: string,
        driver?: ComputerUseDriverId,
        identity?: string,
        check?: () => Promise<void>
    ): Promise<void> {
        const key = JSON.stringify([driver, identity, settings, session ?? '']);
        const cached = configuredSessions.get(key);
        if (cached && cached.expiresAt > Date.now()) return cached.ready;
        if (configuredSessions.size >= 32) configuredSessions.clear();
        const ready = applySettings(settings, session, activityId, driver, check).then((errors) => {
            if (errors.length > 0) {
                configuredSessions.delete(key);
                throw new Error(errors.join('\n'));
            }
        });
        configuredSessions.set(key, { expiresAt: Date.now() + 30 * 60 * 1000, ready });
        return ready;
    }

    async function setRecording(enabled: boolean): Promise<void> {
        const driver = await loadDriver();
        const directory = enabled ? await loadRecordingDirectory() : undefined;
        if (driver === 'cua-driver') await computerUse.setRecording(enabled, directory);
        else await computerUse.setRecording(enabled, directory, driver);
    }

    async function setRecordingEnabled(enabled: boolean): Promise<ComputerUseSettings> {
        const previous = await loadSettings();
        await setRecording(enabled);
        try {
            return await saveSettings({ recordingEnabled: enabled });
        } catch (error) {
            await setRecording(previous.recordingEnabled);
            throw error;
        }
    }

    async function loadRecordingDirectory(selected?: ComputerUseDriverId): Promise<string> {
        const driver = selected ?? (await loadDriver());
        const stored = await getSettingValue({ key: recordingDirectoryKey(driver) });
        return (
            stored ||
            (await join(
                await paths.getAppDirectoryPath('CACHE'),
                'computer-use-trajectories',
                driver
            ))
        );
    }

    async function saveRecordingDirectory(directory: string): Promise<string> {
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
    function execute(
        tool: string,
        args: Record<string, unknown> = {},
        signal?: AbortSignal,
        activitySignal?: AbortSignal,
        captured?: {
            driver: ComputerUseDriverId;
            settings: ComputerUseSettings;
            generation: number;
            directory: string;
            recordingDirectory?: string;
            groups: ComputerUseGroups;
            check(): Promise<void>;
        }
    ): ComputerUseInvocation {
        const executionId = crypto.randomUUID();
        let cancelled = false;
        const check = async () => {
            if (
                disposed ||
                cancelled ||
                signal?.aborted ||
                activitySignal?.aborted ||
                (activitySignal && finishedActivities.has(activitySignal))
            )
                throw new Error('computer use cancelled');
            if (captured) {
                await captured.check();
                const groups = await loadGroups();
                if (disabledToolGroup(tool, groups))
                    throw new Error('computer_use_permission_revoked');
            }
        };
        const invocation: ComputerUseInvocation = {
            executionId,
            result: (captured ? Promise.resolve(captured.settings) : loadSettings()).then(
                async (settings) => {
                    const driver = captured?.driver ?? (await loadDriver());
                    await check();
                    const activity =
                        (activitySignal ?? signal)
                            ? activities.get((activitySignal ?? signal)!)
                            : undefined;
                    if (activity) {
                        await activity.ready;
                        await check();
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
                    if (settings.recordingEnabled) {
                        await check();
                        await computerUse.setRecording(
                            true,
                            captured?.recordingDirectory ?? (await loadRecordingDirectory(driver)),
                            driver
                        );
                    }
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
                            activity?.id,
                            driver,
                            captured
                                ? JSON.stringify([captured.generation, captured.directory])
                                : undefined,
                            check
                        );
                    }
                    await check();
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
                    await check();
                    if (tool === 'end_session') configuredSessions.clear();
                    return result;
                }
            ),
            cancel: () => {
                cancelled = true;
                return computerUse.cancel(executionId);
            },
        };
        invocations.add(invocation);
        invocation.result = invocation.result.finally(() => invocations.delete(invocation));
        return invocation;
    }

    /**
     * Approvals remembered for this app session, keyed by target window.
     * In-memory on purpose: quitting TouchAI forgets every grant.
     */
    const sessionApprovals = new Set<string>();

    function targetKey(pid?: unknown, windowId?: unknown): string {
        return `${String(pid ?? '-')}:${String(windowId ?? '-')}`;
    }

    function allowForSession(key: string): void {
        sessionApprovals.add(key);
    }

    function isAllowedForSession(key: string): boolean {
        return sessionApprovals.has(key);
    }

    function clearSessionApprovals(): void {
        sessionApprovals.clear();
    }

    const capabilities = {
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
        applySavedSettings: async () => applySettings(await loadSettings()),
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
        setRecordingEnabled,
        status,
        targetKey,
    } as const;
    async function capture(): Promise<ComputerControlBinding> {
        if (disposed) throw new Error('computer use disposed');
        const driver = await loadDriver();
        const generation = driverGeneration;
        const directory = observedDriverDirectory!;
        const settings = structuredClone(await loadSettings());
        const groups = structuredClone(await loadGroups());
        const tools = structuredClone(await listTools());
        const recordingDirectory = settings.recordingEnabled
            ? await loadRecordingDirectory(driver)
            : undefined;
        const check = async () => {
            if (
                disposed ||
                !(await isEnabled()) ||
                (await loadDriver()) !== driver ||
                driverGeneration !== generation ||
                observedDriverDirectory !== directory
            ) {
                throw new Error('computer_use_binding_revoked');
            }
            const live = await loadSettings();
            const approvalRank = { each: 0, 'session-window': 1, 'full-access': 2 };
            const normalizeApp = (value: string) =>
                value
                    .trim()
                    .toLowerCase()
                    .split(/[\\/]/)
                    .pop()!
                    .replace(/\.exe$/, '');
            const liveApps = new Set(live.allowedApps.map(normalizeApp));
            if (
                (settings.allowForeground && !live.allowForeground) ||
                (settings.recordingEnabled && !live.recordingEnabled) ||
                (settings.telemetryEnabled && !live.telemetryEnabled) ||
                approvalRank[live.approval] < approvalRank[settings.approval] ||
                (liveApps.size > 0 &&
                    (settings.allowedApps.length === 0 ||
                        settings.allowedApps.some((app) => !liveApps.has(normalizeApp(app)))))
            ) {
                throw new Error('computer_use_permission_revoked');
            }
        };
        await check();
        const captured = {
            driver,
            generation,
            directory,
            settings,
            groups,
            recordingDirectory,
            check,
        };
        const binding: ComputerControlBinding = Object.freeze({
            capture: async () => binding,
            loadDriver: async () => driver,
            loadSettings: async () => structuredClone(settings),
            loadGroups: async () => structuredClone(groups),
            listTools: async () => structuredClone(tools),
            isEnabled: async () => {
                try {
                    await check();
                    return true;
                } catch {
                    return false;
                }
            },
            bindTask,
            startActivity,
            endActivity,
            pulseGlow,
            allowForSession,
            isAllowedForSession,
            execute: (
                tool: string,
                args?: Record<string, unknown>,
                signal?: AbortSignal,
                activitySignal?: AbortSignal
            ) => execute(tool, args, signal, activitySignal, captured),
        });
        return binding;
    }
    return Object.freeze({
        ...capabilities,
        capture,
        async dispose() {
            disposed = true;
            await Promise.allSettled([...invocations].map((invocation) => invocation.cancel()));
            await Promise.allSettled([...activitySignals].map(endActivity));
            configuredSessions.clear();
            clearSessionApprovals();
            catalog = undefined;
        },
    });
}
