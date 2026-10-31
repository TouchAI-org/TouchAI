import {
    beginUpdateOperation,
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

import type { AppUpdateChannel } from '@/config/appUpdate';
import { useSettingsStore } from '@/stores/settings';

import { createInitialAppUpdateState, reduceAppUpdateState } from './state';
import { AUTO_CHECK_INTERVAL_MS, isWithinAppUpdateHours } from './timing';
import type { AppUpdateCheckResult, AppUpdateInfo, AppUpdateState } from './types';

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
        fileName: string
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

/**
 * Update lifecycle analytics. Injected so the controller stays testable and so
 * telemetry stays off the check/download critical path.
 */
export interface AppUpdateAnalytics {
    beginUpdateOperation: () => Promise<UpdateOperation>;
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
}

const defaultAppUpdateAnalytics: AppUpdateAnalytics = {
    beginUpdateOperation,
    trackUpdateTransition,
};

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function mapUpdateSource(source: AppUpdateCheckSource): UpdateSource {
    if (source === 'automatic') {
        return 'background';
    }
    return source === 'manual' || source === 'settings-open' ? 'user' : 'other';
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
    private initialized = false;
    private initializePromise: Promise<void> | null = null;
    private checkPromise: Promise<boolean> | null = null;
    private lastCheckAttemptAt: string | null = null;
    private reportCheckErrors = false;
    private updateOperationPromise: Promise<UpdateOperation | null> | null = null;
    private updateSource: UpdateSource = 'user';
    private unlistenProgress: UnlistenFn | null = null;
    private unlistenCheckEvents: UnlistenFn | null = null;

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

    subscribe(listener: StateListener): () => void {
        this.listeners.add(listener);
        listener(this.getState());
        return () => {
            this.listeners.delete(listener);
        };
    }

    async initialize(): Promise<void> {
        if (this.initialized) {
            return;
        }

        if (this.initializePromise) {
            return this.initializePromise;
        }

        this.initializePromise = this.initializeController();
        try {
            await this.initializePromise;
        } finally {
            this.initializePromise = null;
        }
    }

    private async initializeController(): Promise<void> {
        await this.settings.initialize();
        this.syncSettings();
        await Promise.all([this.listenForProgress(), this.listenForCheckResults()]);
        this.initialized = true;
    }

    async dispose(): Promise<void> {
        if (this.unlistenProgress) {
            this.unlistenProgress();
            this.unlistenProgress = null;
        }
        this.unlistenCheckEvents?.();
        this.unlistenCheckEvents = null;
        this.initialized = false;
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

        if (['downloading', 'downloaded', 'installing'].includes(this.state.status)) {
            return false;
        }

        if (source === 'automatic' && !this.shouldRunAutomaticCheck()) {
            return false;
        }

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
                this.syncSettings();
                return false;
            }

            const checkedAt = this.now();
            this.commit({ type: 'check-completed', channel, result, checkedAt });
            await this.settings.updateAppUpdateLastCheckedAt(checkedAt);
            void this.checkEvents?.publish(result, checkedAt).catch((error) => {
                log.warn('[AppUpdateService] Failed to share update check:', error);
            });
            this.queueUpdateTransition('check_finished', {
                result: result.status === 'unsupported' ? 'unavailable' : 'success',
                source,
                fromVersion,
                toVersion: result.status === 'available' ? result.update.version : undefined,
            });
            if (result.status !== 'available') {
                this.updateOperationPromise = null;
            }
            return true;
        } catch (error) {
            if (this.state.channel !== channel || this.settings.getChannel() !== channel) {
                this.syncSettings();
                return false;
            }

            if (!this.reportCheckErrors) {
                this.replaceState(previousState);
                return false;
            }

            this.commit({ type: 'failed', error: toErrorMessage(error) });
            this.queueUpdateTransition('check_finished', {
                result: 'failure',
                source,
                fromVersion,
            });
            this.updateOperationPromise = null;
            return false;
        }
    }

    async download(): Promise<boolean> {
        await this.initialize();
        this.syncSettings();
        const update = this.state.status === 'available' ? this.state.availableUpdate : null;
        if (!update) return false;

        const channel = this.state.channel;
        this.queueUpdateTransition('download_started', {
            result: 'success',
            source: this.updateSource,
            fromVersion: this.state.currentVersion,
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
                toVersion: downloaded.version,
            });
            return true;
        } catch (error) {
            this.commit({ type: 'failed', error: toErrorMessage(error) });
            this.queueUpdateTransition('download_finished', {
                result: 'failure',
                source: this.updateSource,
                toVersion: update.version,
            });
            return false;
        }
    }

    async install(): Promise<boolean> {
        await this.initialize();
        this.syncSettings();
        const update = this.state.status === 'downloaded' ? this.state.downloadedUpdate : null;
        if (!update) return false;

        const channel = this.state.channel;
        this.commit({ type: 'install-started' });

        try {
            await this.native.installUpdate(channel, update.version, update.fileName);
            this.queueUpdateTransition('install_handoff', {
                result: 'success',
                source: this.updateSource,
                toVersion: update.version,
            });
            this.updateOperationPromise = null;
            return true;
        } catch (error) {
            this.commit({ type: 'failed', error: toErrorMessage(error) });
            this.queueUpdateTransition('install_handoff', {
                result: 'failure',
                source: this.updateSource,
                toVersion: update.version,
            });
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
        this.updateOperationPromise ??= this.analytics
            .beginUpdateOperation()
            .catch(() => null as UpdateOperation | null);
        const operationPromise = this.updateOperationPromise;
        void operationPromise
            .then((operation) =>
                operation ? this.analytics.trackUpdateTransition(operation, phase, outcome) : null
            )
            .catch(() => {
                // Telemetry must never affect an update decision.
            });
    }

    private shouldRunAutomaticCheck(): boolean {
        if (!this.state.autoCheckEnabled) {
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

        return now - lastCheckedAt >= AUTO_CHECK_INTERVAL_MS;
    }

    private syncSettings(): void {
        const channel = this.settings.getChannel();
        const autoCheckEnabled = this.settings.getAutoCheckEnabled();
        const lastCheckedAt = this.settings.getLastCheckedAt();

        if (channel !== this.state.channel) {
            this.lastCheckAttemptAt = null;
            this.commit({ type: 'channel-updated', channel });
        }

        if (
            autoCheckEnabled !== this.state.autoCheckEnabled ||
            lastCheckedAt !== this.state.lastCheckedAt
        ) {
            this.commit({ type: 'settings-loaded', channel, autoCheckEnabled, lastCheckedAt });
        }
    }

    private async listenForProgress(): Promise<void> {
        if (this.unlistenProgress) {
            return;
        }

        try {
            this.unlistenProgress = await listen<number>('updater://download-progress', (event) => {
                this.commit({ type: 'download-progress', progress: event.payload });
            });
        } catch (error) {
            log.warn('[AppUpdateService] Failed to listen for update progress:', error);
        }
    }

    private async listenForCheckResults(): Promise<void> {
        if (!this.checkEvents || this.unlistenCheckEvents) {
            return;
        }

        try {
            this.unlistenCheckEvents = await this.checkEvents.listen((result, checkedAt) => {
                if (
                    result.channel !== this.settings.getChannel() ||
                    this.checkPromise ||
                    (parseTime(checkedAt) ?? 0) < (parseTime(this.state.lastCheckedAt) ?? 0) ||
                    ['downloading', 'downloaded', 'installing'].includes(this.state.status)
                ) {
                    return;
                }

                this.commit({
                    type: 'check-completed',
                    channel: result.channel,
                    result,
                    checkedAt,
                });
            });
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
