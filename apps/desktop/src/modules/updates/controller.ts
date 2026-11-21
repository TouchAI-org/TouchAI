import type { AppUpdateChannel } from '@/config/appUpdate';

import { getDownloadableAppUpdate, getInstallableAppUpdate } from './availability';
import type {
    AppUpdateAnalytics,
    UpdateOperation,
    UpdatePhase,
    UpdateResult,
    UpdateSource,
} from './ports';
import { createInitialAppUpdateState, reduceAppUpdateState } from './state';
import { AUTO_CHECK_INTERVAL_MS, isWithinAppUpdateHours } from './timing';
import type {
    AppUpdateCheckResult,
    AppUpdateInfo,
    AppUpdateInstallAnalytics,
    AppUpdateState,
} from './types';

type UnlistenFn = () => void;
export type AppUpdateCheckSource = 'manual' | 'automatic' | 'settings-open';

/**
 * One check decision. Only the attempt the controller still owns may commit
 * state, persist a checked time, or finish the update operation, so a reply
 * that arrives after a channel switch or a newer check is discarded.
 */
interface UpdateCheckAttempt {
    readonly id: number;
    readonly channel: AppUpdateChannel;
}

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

interface AppUpdateControllerDeps<Operation extends UpdateOperation> {
    native: AppUpdateNativeAdapter;
    settings: AppUpdateSettingsAdapter;
    analytics: AppUpdateAnalytics<Operation>;
    progress: { listen(listener: (progress: number) => void): Promise<UnlistenFn> };
    environment: { isOnline(): boolean; offlineMessage(): string };
    diagnostics: { warn(message: string, error: unknown): void };
    checkEvents?: {
        listen: (
            listener: (result: AppUpdateCheckResult, checkedAt: string) => void
        ) => Promise<UnlistenFn>;
        publish: (result: AppUpdateCheckResult, checkedAt: string) => Promise<void>;
    };
    now?: () => string;
}

type StateListener = (state: AppUpdateState) => void;

interface UpdateInitialization {
    state: 'pending' | 'ready' | 'disposed';
    promise: Promise<void> | null;
    unlistenProgress: UnlistenFn | null;
    unlistenCheckEvents: UnlistenFn | null;
}

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

export class AppUpdateController<Operation extends UpdateOperation = UpdateOperation> {
    private state = createInitialAppUpdateState();
    private readonly listeners = new Set<StateListener>();
    private readonly native: AppUpdateNativeAdapter;
    private readonly settings: AppUpdateSettingsAdapter;
    private readonly analytics: AppUpdateAnalytics<Operation>;
    private readonly now: () => string;
    private readonly progress: AppUpdateControllerDeps<Operation>['progress'];
    private readonly environment: AppUpdateControllerDeps<Operation>['environment'];
    private readonly diagnostics: AppUpdateControllerDeps<Operation>['diagnostics'];
    private readonly checkEvents: AppUpdateControllerDeps<Operation>['checkEvents'];
    private initialization: UpdateInitialization | null = null;
    private activeCheck: UpdateCheckAttempt | null = null;
    private channelSwitch: Promise<void> | null = null;
    private checkSequence = 0;
    private checkPromise: Promise<boolean> | null = null;
    private preferenceWrites: Promise<void> = Promise.resolve();
    private downloadPromise: Promise<boolean> | null = null;
    private installPromise: Promise<boolean> | null = null;
    private lastCheckAttemptAt: string | null = null;
    private consecutiveCheckFailures = 0;
    private reportCheckErrors = false;
    private updateOperationPromise: Promise<Operation | null> | null = null;
    private updateOperation: Operation | null = null;
    private updateOperationId: string | null = null;
    private updateOperationOwner: number | null = null;
    private updateSource: UpdateSource = 'user';

    constructor(deps: AppUpdateControllerDeps<Operation>) {
        this.native = deps.native;
        this.settings = deps.settings;
        this.analytics = deps.analytics;
        this.progress = deps.progress;
        this.environment = deps.environment;
        this.diagnostics = deps.diagnostics;
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
        if (this.initialization?.state === 'ready') {
            return;
        }

        if (this.initialization?.state === 'pending') {
            return this.initialization.promise!;
        }

        const initialization: UpdateInitialization = {
            state: 'pending',
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
            if (this.isInitializationActive(initialization)) initialization.state = 'ready';
        } catch (error) {
            this.releaseInitialization(initialization);
            throw error;
        }
    }

    private isInitializationActive(initialization: UpdateInitialization): boolean {
        return initialization.state !== 'disposed';
    }

    private releaseInitialization(initialization: UpdateInitialization): void {
        initialization.state = 'disposed';
        const { unlistenProgress, unlistenCheckEvents } = initialization;
        initialization.unlistenProgress = null;
        initialization.unlistenCheckEvents = null;
        unlistenProgress?.();
        unlistenCheckEvents?.();
    }

    async dispose(): Promise<void> {
        this.supersedeCheck();
        this.releaseUpdateOperation();
        if (this.initialization) {
            this.releaseInitialization(this.initialization);
        }
    }

    async setAutoCheckEnabled(enabled: boolean): Promise<void> {
        await this.initialize();
        if (!this.initialization || !this.isInitializationActive(this.initialization)) return;
        await this.writePreference(() => this.settings.updateAppUpdateAutoCheck(enabled));
        if (!this.isInitializationActive(this.initialization)) return;
        this.commit({ type: 'auto-check-updated', enabled });

        if (enabled) {
            await this.checkNow('manual');
        }
    }

    async setChannel(channel: AppUpdateChannel): Promise<void> {
        await this.initialize();
        if (!this.initialization || !this.isInitializationActive(this.initialization)) return;
        // Decisions apply in call order, so a switch that is still saving
        // finishes before this one starts saving.
        await this.settleChannelSwitch();
        // The switch is a new decision: the check that is still running belongs
        // to the previous channel and may no longer report or persist anything.
        this.supersedeCheck();
        this.lastCheckAttemptAt = null;
        this.consecutiveCheckFailures = 0;

        // A check decided while this switch is saving belongs to the channel the
        // user chose, so it waits for the switch instead of checking the old one.
        let settleSwitch!: () => void;
        const switching = new Promise<void>((resolve) => {
            settleSwitch = resolve;
        });
        this.channelSwitch = switching;
        try {
            await this.writePreference(() => this.settings.updateAppUpdateChannel(channel));
            if (!this.isInitializationActive(this.initialization)) return;
            await this.writePreference(() => this.settings.updateAppUpdateLastCheckedAt(null));
            if (!this.isInitializationActive(this.initialization)) return;
            this.commit({ type: 'channel-updated', channel });
        } finally {
            if (this.channelSwitch === switching) {
                this.channelSwitch = null;
            }
            settleSwitch();
        }
    }

    /**
     * Resolves once every channel switch already requested has been saved and
     * committed. The signal never rejects, so a failed save cannot leave a
     * caller waiting forever; the switch's own caller still sees the failure.
     */
    private async settleChannelSwitch(): Promise<void> {
        while (this.channelSwitch) {
            await this.channelSwitch;
        }
    }

    private beginCheck(channel: AppUpdateChannel): UpdateCheckAttempt {
        const attempt = { id: ++this.checkSequence, channel };
        this.activeCheck = attempt;
        return attempt;
    }

    private isCurrentCheck(attempt: UpdateCheckAttempt): boolean {
        return this.activeCheck === attempt;
    }

    /**
     * Ends the running check without letting it report anything. The decision
     * that supersedes it, a channel switch or a newer check, owns the state and
     * the saved preferences from then on.
     */
    private supersedeCheck(): void {
        this.activeCheck = null;
    }

    private ownsCheck(initialization: UpdateInitialization, attempt: UpdateCheckAttempt): boolean {
        return (
            this.isInitializationActive(initialization) &&
            this.isCurrentCheck(attempt) &&
            this.state.channel === attempt.channel &&
            this.settings.getChannel() === attempt.channel
        );
    }

    /**
     * Drops a superseded check. Its update operation is only released while the
     * attempt still owns it, so a newer check keeps its own telemetry handle.
     */
    private abandonCheck(initialization: UpdateInitialization, attempt: UpdateCheckAttempt): void {
        if (this.updateOperationOwner === attempt.id) {
            this.updateOperationOwner = null;
            this.releaseUpdateOperation();
        }
        if (this.isInitializationActive(initialization)) {
            this.syncSettings();
        }
    }

    /**
     * Settings writes apply in decision order. A slow save from a check the user
     * already replaced therefore lands before the newer decision's save instead
     * of overwriting it.
     */
    private writePreference<T>(write: () => Promise<T>): Promise<T> {
        const result = this.preferenceWrites.then(write, write);
        this.preferenceWrites = result.then(
            () => undefined,
            () => undefined
        );
        return result;
    }

    async checkNow(source: AppUpdateCheckSource = 'manual'): Promise<boolean> {
        await this.initialize();
        if (!this.initialization || !this.isInitializationActive(this.initialization)) return false;
        // Wait for the saved channel to match the one the user picked, otherwise
        // the check would run against the channel the switch is replacing.
        await this.settleChannelSwitch();
        if (!this.initialization || !this.isInitializationActive(this.initialization)) return false;
        this.syncSettings();
        const reportErrors =
            source === 'manual' ||
            (source === 'settings-open' && this.state.currentVersion === null);

        // Only a check that still owns the decision for the selected channel is
        // shared. A superseded check would swallow this request without checking
        // the current channel.
        if (
            this.checkPromise &&
            this.activeCheck &&
            this.activeCheck.channel === this.state.channel &&
            this.activeCheck.channel === this.settings.getChannel()
        ) {
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
        const attempt = this.beginCheck(this.state.channel);
        this.updateOperationOwner = attempt.id;
        const check = this.performCheck(attempt);
        this.checkPromise = check;
        const releaseCheck = () => {
            if (this.checkPromise === check) {
                this.checkPromise = null;
            }
        };
        void check.then(releaseCheck, releaseCheck);
        return check;
    }

    private async performCheck(attempt: UpdateCheckAttempt): Promise<boolean> {
        const initialization = this.initialization!;
        const channel = attempt.channel;
        const source = this.updateSource;
        const fromVersion = this.state.currentVersion;
        const previousOutcome = {
            status: this.state.status,
            error: this.state.error,
            unsupportedReason: this.state.unsupportedReason,
        };
        this.queueUpdateTransition('check_started', {
            result: 'success',
            source,
            fromVersion,
        });
        this.commit({ type: 'check-started', channel });

        try {
            const result = await this.native.checkForUpdates(channel);
            if (!this.ownsCheck(initialization, attempt)) {
                // The reply belongs to a decision that has already been replaced.
                this.abandonCheck(initialization, attempt);
                return false;
            }

            const checkedAt = this.now();
            this.consecutiveCheckFailures = 0;
            this.commit({ type: 'check-completed', channel, result, checkedAt });
            await this.writePreference(() => this.settings.updateAppUpdateLastCheckedAt(checkedAt));
            if (!this.ownsCheck(initialization, attempt)) {
                // The save only landed now; the switch queued its own save for
                // after it, and this check may not report anything any more.
                this.abandonCheck(initialization, attempt);
                return false;
            }
            void this.checkEvents?.publish(result, checkedAt).catch((error) => {
                this.diagnostics.warn('[AppUpdateService] Failed to share update check:', error);
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
            if (!this.ownsCheck(initialization, attempt)) {
                this.abandonCheck(initialization, attempt);
                return false;
            }

            this.consecutiveCheckFailures = Math.min(this.consecutiveCheckFailures + 1, 7);
            if (!this.reportCheckErrors) {
                // Only the fields the check itself changed go back; a preference
                // the user changed meanwhile must survive the quiet failure.
                this.commit({
                    type: 'check-reverted',
                    status: previousOutcome.status,
                    error: previousOutcome.error,
                    unsupportedReason: previousOutcome.unsupportedReason,
                });
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
                error: !this.environment.isOnline()
                    ? this.environment.offlineMessage()
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
        if (!this.initialization || !this.isInitializationActive(this.initialization)) return false;
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
        const initialization = this.initialization!;
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
            if (!this.isInitializationActive(initialization)) return false;
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
            if (!this.isInitializationActive(initialization)) return false;
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
        if (!this.initialization || !this.isInitializationActive(this.initialization)) return false;
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
        const initialization = this.initialization!;
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
            if (!this.isInitializationActive(initialization)) return false;
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
                .catch(() => null as Operation | null);
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
        this.updateOperationOwner = null;
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
        if (!this.state.autoCheckEnabled || !this.environment.isOnline()) {
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
            // Another owner changed the channel: the running check belongs to
            // the previous channel and no longer owns the decision.
            this.supersedeCheck();
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
            const unlisten = await this.progress.listen((progress) => {
                if (!this.isInitializationActive(initialization)) return;
                this.commit({ type: 'download-progress', progress });
            });
            if (!this.isInitializationActive(initialization)) {
                unlisten();
                return;
            }
            initialization.unlistenProgress = unlisten;
        } catch (error) {
            this.diagnostics.warn(
                '[AppUpdateService] Failed to listen for update progress:',
                error
            );
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
            this.diagnostics.warn('[AppUpdateService] Failed to listen for update checks:', error);
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
