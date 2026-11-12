import {
    beginUpdateOperation,
    finishUpdateOperation,
    trackUpdateTransition,
    type UpdateOperation,
    type UpdatePhase,
    type UpdateResult,
    type UpdateSource,
} from '@services/AnalyticsService/lifecycle';
import { AppEvent, eventService } from '@services/EventService';
import { native } from '@services/NativeService';
import { log } from '@services/ObservabilityService';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useStateMachine } from 'reka-ui';

import type { AppUpdateChannel } from '@/config/appUpdate';
import { t } from '@/i18n';
import { useSettingsStore } from '@/stores/settings';

import { getDownloadableAppUpdate, getInstallableAppUpdate } from './availability';
import { createInitialAppUpdateState, reduceAppUpdateState } from './state';
import { AUTO_CHECK_INTERVAL_MS, isWithinAppUpdateHours } from './timing';
import type {
    AppUpdateCheckResult,
    AppUpdateInfo,
    AppUpdateInstallAnalytics,
    AppUpdateState,
} from './types';

export type AppUpdateCheckSource = 'manual' | 'automatic' | 'settings-open';

interface AppUpdateNativeAdapter {
    checkForUpdates: (channel: AppUpdateChannel) => Promise<AppUpdateCheckResult>;
    downloadUpdate: (
        channel: AppUpdateChannel,
        version: string,
        fileName: string
    ) => Promise<AppUpdateInfo>;
    installUpdate: (
        channel: AppUpdateChannel,
        version: string,
        fileName: string,
        analytics: AppUpdateInstallAnalytics
    ) => Promise<boolean>;
}

interface AppUpdateSettingsAdapter {
    initialize: () => Promise<void>;
    getChannel: () => AppUpdateChannel;
    getAutoCheckEnabled: () => boolean;
    getLastCheckedAt: () => string | null;
    updateAppUpdateChannel: (channel: AppUpdateChannel) => Promise<void>;
    updateAppUpdateAutoCheck: (enabled: boolean) => Promise<void>;
    updateAppUpdateLastCheckedAt: (checkedAt: string | null) => Promise<void>;
}

interface AppUpdateControllerDeps {
    native: AppUpdateNativeAdapter;
    settings: AppUpdateSettingsAdapter;
    analytics?: AppUpdateAnalytics;
    checkEvents?: {
        listen: (
            listener: (result: AppUpdateCheckResult, checkedAt: string) => void
        ) => Promise<UnlistenFn>;
        publish: (result: AppUpdateCheckResult, checkedAt: string) => Promise<void>;
    };
    now?: () => string;
}

type StateListener = (state: AppUpdateState) => void;

const INITIALIZATION_LIFECYCLE = {
    pending: { ready: 'ready', dispose: 'disposed' },
    ready: { dispose: 'disposed' },
    disposed: {},
} as const;

type UpdateInitialization = ReturnType<typeof useStateMachine<typeof INITIALIZATION_LIFECYCLE>> & {
    promise: Promise<void> | null;
    unlistenProgress: UnlistenFn | null;
    unlistenCheckEvents: UnlistenFn | null;
};

/**
 * Update lifecycle analytics. Injected so the controller stays testable and so
 * telemetry stays off the check/download critical path.
 */
export interface AppUpdateAnalytics {
    beginUpdateOperation: (updateOperationId?: string) => Promise<UpdateOperation>;
    trackUpdateTransition: (
        operation: UpdateOperation,
        phase: UpdatePhase,
        outcome: {
            result: UpdateResult;
            source: UpdateSource;
            fromVersion?: string | null;
            toVersion?: string | null;
        }
    ) => Promise<void>;
    finishUpdateOperation: (operation: UpdateOperation) => Promise<void>;
}

const defaultAppUpdateAnalytics: AppUpdateAnalytics = {
    beginUpdateOperation,
    trackUpdateTransition,
    finishUpdateOperation,
};

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function mapUpdateSource(source: AppUpdateCheckSource): UpdateSource {
    if (source === 'automatic') {
        return 'background';
    }
    // Opening settings can trigger an automatic check. It is not a user asking
    // for an update, so only an explicit manual check is reported as `user`.
    return source === 'manual' ? 'user' : 'other';
}

function parseTime(value: string | null): number | null {
    if (!value) {
        return null;
    }

    const time = Date.parse(value);
    return Number.isFinite(time) ? time : null;
}

export class AppUpdateController {
    private state = createInitialAppUpdateState();
    private readonly listeners = new Set<StateListener>();
    private readonly native: AppUpdateNativeAdapter;
    private readonly settings: AppUpdateSettingsAdapter;
    private readonly analytics: AppUpdateAnalytics;
    private readonly now: () => string;
    private readonly checkEvents: AppUpdateControllerDeps['checkEvents'];
    private initialization: UpdateInitialization | null = null;
    private checkPromise: Promise<boolean> | null = null;
    private downloadPromise: Promise<boolean> | null = null;
    private installPromise: Promise<boolean> | null = null;
    private lastCheckAttemptAt: string | null = null;
    private consecutiveCheckFailures = 0;
    private reportCheckErrors = false;
    private updateOperationPromise: Promise<UpdateOperation | null> | null = null;
    private updateOperation: UpdateOperation | null = null;
    private updateOperationId: string | null = null;
    private updateSource: UpdateSource = 'user';

    constructor(deps: AppUpdateControllerDeps) {
        this.native = deps.native;
        this.settings = deps.settings;
        this.analytics = deps.analytics ?? defaultAppUpdateAnalytics;
        this.checkEvents = deps.checkEvents;
        this.now = deps.now ?? (() => new Date().toISOString());
    }

    getState(): AppUpdateState {
        return { ...this.state };
    }

    getAutomaticCheckInterval(): number {
        return this.consecutiveCheckFailures > 0
            ? Math.min(AUTO_CHECK_INTERVAL_MS, 60_000 * 2 ** (this.consecutiveCheckFailures - 1))
            : AUTO_CHECK_INTERVAL_MS;
    }

    /**
     * The later of the latest check attempt and the latest completed check.
     *
     * The automatic-check gate uses the same boundary, so scheduling from this
     * value cannot move a check past the deadline the gate will accept.
     */
    getLastCheckAttemptAt(): string | null {
        const attemptAt = parseTime(this.lastCheckAttemptAt);
        const completedAt = parseTime(this.state.lastCheckedAt);
        if (attemptAt === null) return this.state.lastCheckedAt;
        if (completedAt === null) return this.lastCheckAttemptAt;
        return attemptAt >= completedAt ? this.lastCheckAttemptAt : this.state.lastCheckedAt;
    }

    subscribe(listener: StateListener): () => void {
        this.listeners.add(listener);
        listener(this.getState());
        return () => {
            this.listeners.delete(listener);
        };
    }

    async initialize(): Promise<void> {
        if (this.initialization?.state.value === 'ready') {
            return;
        }

        if (this.initialization?.state.value === 'pending') {
            return this.initialization.promise!;
        }

        const initialization: UpdateInitialization = {
            ...useStateMachine('pending', INITIALIZATION_LIFECYCLE),
            promise: null,
            unlistenProgress: null,
            unlistenCheckEvents: null,
        };
        this.initialization = initialization;
        initialization.promise = this.initializeController(initialization);
        return initialization.promise;
    }

    private async initializeController(initialization: UpdateInitialization): Promise<void> {
        try {
            await this.settings.initialize();
            if (!this.isInitializationActive(initialization)) return;
            this.syncSettings();
            if (!this.isInitializationActive(initialization)) return;
            await Promise.all([
                this.listenForProgress(initialization),
                this.listenForCheckResults(initialization),
            ]);
            initialization.dispatch('ready');
        } catch (error) {
            this.releaseInitialization(initialization);
            throw error;
        }
    }

    private isInitializationActive(initialization: UpdateInitialization): boolean {
        return initialization.state.value !== 'disposed';
    }

    private releaseInitialization(initialization: UpdateInitialization): void {
        initialization.dispatch('dispose');
        const { unlistenProgress, unlistenCheckEvents } = initialization;
        initialization.unlistenProgress = null;
        initialization.unlistenCheckEvents = null;
        unlistenProgress?.();
        unlistenCheckEvents?.();
    }

    async dispose(): Promise<void> {
        this.releaseUpdateOperation();
        if (this.initialization) {
            this.releaseInitialization(this.initialization);
        }
    }

    async setAutoCheckEnabled(enabled: boolean): Promise<void> {
        await this.initialize();
        await this.settings.updateAppUpdateAutoCheck(enabled);
        this.commit({ type: 'auto-check-updated', enabled });

        if (enabled) {
            await this.checkNow('manual');
        }
    }

    async setChannel(channel: AppUpdateChannel): Promise<void> {
        await this.initialize();
        await this.settings.updateAppUpdateChannel(channel);
        await this.settings.updateAppUpdateLastCheckedAt(null);
        this.lastCheckAttemptAt = null;
        this.consecutiveCheckFailures = 0;
        this.commit({ type: 'channel-updated', channel });
    }

    async checkNow(source: AppUpdateCheckSource = 'manual'): Promise<boolean> {
        await this.initialize();
        this.syncSettings();
        const reportErrors =
            source === 'manual' ||
            (source === 'settings-open' && this.state.currentVersion === null);

        if (this.checkPromise) {
            this.reportCheckErrors ||= reportErrors;
            return this.checkPromise;
        }

        if (
            ['downloading', 'installing'].includes(this.state.status) ||
            // A manual recheck may refresh release metadata while a package is
            // downloaded; the reducer keeps the package when the target is
            // unchanged. Background and settings checks leave it untouched.
            (source !== 'manual' &&
                (this.state.status === 'downloaded' ||
                    Boolean(getInstallableAppUpdate(this.state))))
        ) {
            return false;
        }

        if (source === 'automatic' && !this.shouldRunAutomaticCheck()) {
            return false;
        }

        // A new decision replaces any previous chain that never reached a
        // terminal phase (for example a check that offered an update the user
        // did not download).
        this.releaseUpdateOperation();
        this.updateOperationId = crypto.randomUUID();
        this.reportCheckErrors = reportErrors;
        this.lastCheckAttemptAt = this.now();
        this.updateSource = mapUpdateSource(source);
        this.checkPromise = this.performCheck();
        try {
            return await this.checkPromise;
        } finally {
            this.checkPromise = null;
        }
    }

    private async performCheck(): Promise<boolean> {
        const previousState = this.state;
        const channel = this.state.channel;
        const source = this.updateSource;
        const fromVersion = this.state.currentVersion;
        this.queueUpdateTransition('check_started', {
            result: 'success',
            source,
            fromVersion,
        });
        this.commit({ type: 'check-started', channel });

        try {
            const result = await this.native.checkForUpdates(channel);
            if (this.state.channel !== channel || this.settings.getChannel() !== channel) {
                // The check cannot proceed for this decision; release without
                // reporting a result that belongs to a superseded channel.
                this.releaseUpdateOperation();
                this.syncSettings();
                return false;
            }

            const checkedAt = this.now();
            this.consecutiveCheckFailures = 0;
            this.commit({ type: 'check-completed', channel, result, checkedAt });
            await this.settings.updateAppUpdateLastCheckedAt(checkedAt);
            void this.checkEvents?.publish(result, checkedAt).catch((error) => {
                log.warn('[AppUpdateService] Failed to share update check:', error);
            });
            this.queueUpdateTransition('check_finished', {
                result: result.status === 'unsupported' ? 'unavailable' : 'success',
                source,
                fromVersion: result.currentVersion ?? fromVersion,
                toVersion: result.status === 'available' ? result.update.version : undefined,
            });
            if (result.status !== 'available') {
                this.releaseUpdateOperation();
            }
            return true;
        } catch (error) {
            if (this.state.channel !== channel || this.settings.getChannel() !== channel) {
                this.releaseUpdateOperation();
                this.syncSettings();
                return false;
            }

            this.consecutiveCheckFailures = Math.min(this.consecutiveCheckFailures + 1, 7);
            if (!this.reportCheckErrors) {
                this.replaceState(previousState);
                this.queueUpdateTransition('check_finished', {
                    result: 'failure',
                    source,
                    fromVersion,
                });
                this.releaseUpdateOperation();
                return false;
            }

            this.commit({
                type: 'failed',
                error:
                    typeof navigator !== 'undefined' && navigator.onLine === false
                        ? t('settings.general.update.error.offline')
                        : toErrorMessage(error),
            });
            this.queueUpdateTransition('check_finished', {
                result: 'failure',
                source,
                fromVersion,
            });
            this.releaseUpdateOperation();
            return false;
        }
    }

    async download(): Promise<boolean> {
        await this.initialize();
        this.syncSettings();

        // A second request must not abort or release the single shared update
        // operation while the first download/check/install is still running.
        if (
            this.checkPromise ||
            this.downloadPromise ||
            this.installPromise ||
            ['checking', 'downloading', 'downloaded', 'installing'].includes(this.state.status)
        ) {
            return false;
        }

        const update = getDownloadableAppUpdate(this.state);
        if (!update) {
            this.releaseUpdateOperation();
            return false;
        }

        this.downloadPromise = this.performDownload(update);
        try {
            return await this.downloadPromise;
        } finally {
            this.downloadPromise = null;
        }
    }

    private async performDownload(update: AppUpdateInfo): Promise<boolean> {
        const channel = this.state.channel;
        const fromVersion = this.state.currentVersion;
        this.queueUpdateTransition('download_started', {
            result: 'success',
            source: this.updateSource,
            fromVersion,
            toVersion: update.version,
        });
        this.commit({ type: 'download-started' });

        try {
            const downloaded = await this.native.downloadUpdate(
                channel,
                update.version,
                update.fileName
            );
            if (downloaded.version !== update.version || downloaded.fileName !== update.fileName) {
                throw new Error('Downloaded update does not match the selected update');
            }
            this.commit({ type: 'download-completed', update: downloaded });
            this.queueUpdateTransition('download_finished', {
                result: 'success',
                source: this.updateSource,
                fromVersion,
                toVersion: downloaded.version,
            });
            return true;
        } catch (error) {
            this.commit({ type: 'failed', error: toErrorMessage(error) });
            this.queueUpdateTransition('download_finished', {
                result: 'failure',
                source: this.updateSource,
                fromVersion,
                toVersion: update.version,
            });
            this.releaseUpdateOperation();
            return false;
        }
    }

    async install(): Promise<boolean> {
        await this.initialize();
        this.syncSettings();

        // Same shared-operation rule as download: an in-flight sibling or a
        // status guard must not finish the operation before its real terminal
        // phase.
        if (
            this.checkPromise ||
            this.installPromise ||
            this.downloadPromise ||
            ['checking', 'installing'].includes(this.state.status)
        ) {
            return false;
        }

        const update = getInstallableAppUpdate(this.state);
        if (!update) {
            this.releaseUpdateOperation();
            return false;
        }

        this.installPromise = this.performInstall(update);
        try {
            return await this.installPromise;
        } finally {
            this.installPromise = null;
        }
    }

    private async performInstall(update: AppUpdateInfo): Promise<boolean> {
        const channel = this.state.channel;
        const updateOperationId = this.updateOperationId ?? crypto.randomUUID();
        const operationId = this.updateOperation?.operation.operationId || undefined;
        this.commit({ type: 'install-started' });

        try {
            // Native records the handoff before exiting so pending-update
            // metadata cannot be lost while the WebView is torn down.
            await this.native.installUpdate(channel, update.version, update.fileName, {
                updateOperationId,
                source: this.updateSource,
                ...(operationId ? { operationId } : {}),
            });
            this.releaseUpdateOperation();
            return true;
        } catch (error) {
            this.commit({ type: 'failed', error: toErrorMessage(error) });
            this.releaseUpdateOperation();
            return false;
        }
    }

    /**
     * Queues one fixed update-phase fact without ever blocking the update
     * decision: the operation handle is opened lazily and resolved off the
     * critical path, so state transitions and the user-visible flow keep their
     * original timing even when telemetry is slow or unavailable.
     */
    private queueUpdateTransition(
        phase: UpdatePhase,
        outcome: {
            result: UpdateResult;
            source: UpdateSource;
            fromVersion?: string | null;
            toVersion?: string | null;
        }
    ): void {
        if (!this.updateOperationPromise) {
            const updateOperationId = this.updateOperationId ?? crypto.randomUUID();
            this.updateOperationId = updateOperationId;
            const operationPromise = this.analytics
                .beginUpdateOperation(updateOperationId)
                .catch(() => null as UpdateOperation | null);
            this.updateOperationPromise = operationPromise;
            void operationPromise.then((operation) => {
                if (this.updateOperationPromise === operationPromise) {
                    this.updateOperation = operation;
                }
            });
        }
        const operationPromise = this.updateOperationPromise;
        void operationPromise
            .then((operation) =>
                operation ? this.analytics.trackUpdateTransition(operation, phase, outcome) : null
            )
            .catch(() => {
                // Telemetry must never affect an update decision.
            });
    }

    /**
     * Releases the current update handle after the terminal phase has been
     * queued. The transition keeps the same operation id until here, then the
     * next decision starts a fresh handle.
     */
    private releaseUpdateOperation(): void {
        const operationPromise = this.updateOperationPromise;
        if (!operationPromise) {
            return;
        }
        this.updateOperationPromise = null;
        this.updateOperation = null;
        this.updateOperationId = null;
        void operationPromise
            .then((operation) =>
                operation ? this.analytics.finishUpdateOperation(operation) : null
            )
            .catch(() => {
                // Telemetry must never affect an update decision.
            });
    }

    private shouldRunAutomaticCheck(): boolean {
        if (
            !this.state.autoCheckEnabled ||
            (typeof navigator !== 'undefined' && navigator.onLine === false)
        ) {
            return false;
        }

        const now = parseTime(this.now());
        if (now !== null && !isWithinAppUpdateHours(now)) {
            return false;
        }

        const lastCheckedAt = Math.max(
            parseTime(this.state.lastCheckedAt) ?? 0,
            parseTime(this.lastCheckAttemptAt) ?? 0
        );
        if (!lastCheckedAt || !isWithinAppUpdateHours(lastCheckedAt)) {
            return true;
        }

        if (now === null) {
            return true;
        }

        return now - lastCheckedAt >= this.getAutomaticCheckInterval();
    }

    private syncSettings(): void {
        const channel = this.settings.getChannel();
        const autoCheckEnabled = this.settings.getAutoCheckEnabled();
        const lastCheckedAt = this.settings.getLastCheckedAt();

        if (channel !== this.state.channel) {
            this.lastCheckAttemptAt = null;
            this.consecutiveCheckFailures = 0;
            this.commit({ type: 'channel-updated', channel });
        }

        if (
            autoCheckEnabled !== this.state.autoCheckEnabled ||
            lastCheckedAt !== this.state.lastCheckedAt
        ) {
            this.commit({ type: 'settings-loaded', channel, autoCheckEnabled, lastCheckedAt });
        }
    }

    private async listenForProgress(initialization: UpdateInitialization): Promise<void> {
        try {
            const unlisten = await listen<number>('updater://download-progress', (event) => {
                if (!this.isInitializationActive(initialization)) return;
                this.commit({ type: 'download-progress', progress: event.payload });
            });
            if (!this.isInitializationActive(initialization)) {
                unlisten();
                return;
            }
            initialization.unlistenProgress = unlisten;
        } catch (error) {
            log.warn('[AppUpdateService] Failed to listen for update progress:', error);
        }
    }

    private async listenForCheckResults(initialization: UpdateInitialization): Promise<void> {
        if (!this.checkEvents) {
            return;
        }

        try {
            const unlisten = await this.checkEvents.listen((result, checkedAt) => {
                if (
                    !this.isInitializationActive(initialization) ||
                    result.channel !== this.settings.getChannel() ||
                    this.checkPromise ||
                    (parseTime(checkedAt) ?? 0) < (parseTime(this.state.lastCheckedAt) ?? 0) ||
                    ['downloading', 'downloaded', 'installing'].includes(this.state.status) ||
                    getInstallableAppUpdate(this.state)
                ) {
                    return;
                }

                this.consecutiveCheckFailures = 0;
                this.commit({
                    type: 'check-completed',
                    channel: result.channel,
                    result,
                    checkedAt,
                });
            });
            if (!this.isInitializationActive(initialization)) {
                unlisten();
                return;
            }
            initialization.unlistenCheckEvents = unlisten;
        } catch (error) {
            log.warn('[AppUpdateService] Failed to listen for update checks:', error);
        }
    }

    private commit(action: Parameters<typeof reduceAppUpdateState>[1]): void {
        this.replaceState(reduceAppUpdateState(this.state, action));
    }

    private replaceState(state: AppUpdateState): void {
        this.state = state;
        const snapshot = this.getState();
        this.listeners.forEach((listener) => listener(snapshot));
    }
}

function createSettingsAdapter(): AppUpdateSettingsAdapter {
    const getSettingsStore = () => useSettingsStore();
    return {
        initialize: () => getSettingsStore().initialize(),
        getChannel: () => getSettingsStore().settings.appUpdateChannel,
        getAutoCheckEnabled: () => getSettingsStore().settings.appUpdateAutoCheck,
        getLastCheckedAt: () => getSettingsStore().settings.appUpdateLastCheckedAt,
        updateAppUpdateChannel: (channel) => getSettingsStore().updateAppUpdateChannel(channel),
        updateAppUpdateAutoCheck: (enabled) => getSettingsStore().updateAppUpdateAutoCheck(enabled),
        updateAppUpdateLastCheckedAt: (checkedAt) =>
            getSettingsStore().updateAppUpdateLastCheckedAt(checkedAt),
    };
}

const updateSourceId = crypto.randomUUID();

export const appUpdateService = new AppUpdateController({
    native: native.updater,
    settings: createSettingsAdapter(),
    checkEvents: {
        listen: (listener) =>
            eventService.on(AppEvent.APP_UPDATE_CHECKED, (event) => {
                if (event.sourceId !== updateSourceId) {
                    listener(event.result, event.checkedAt);
                }
            }),
        publish: (result, checkedAt) =>
            eventService.emit(AppEvent.APP_UPDATE_CHECKED, {
                sourceId: updateSourceId,
                result,
                checkedAt,
            }),
    },
});
