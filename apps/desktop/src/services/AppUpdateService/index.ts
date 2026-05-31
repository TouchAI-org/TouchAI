import { native } from '@services/NativeService';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import type { AppUpdateChannel } from '@/config/appUpdate';
import { useSettingsStore } from '@/stores/settings';

import { createInitialAppUpdateState, reduceAppUpdateState } from './state';
import type { AppUpdateCheckResult, AppUpdateInfo, AppUpdateState } from './types';

export type AppUpdateCheckSource = 'manual' | 'automatic';

interface AppUpdateNativeAdapter {
    checkForUpdates: (channel: AppUpdateChannel) => Promise<AppUpdateCheckResult>;
    downloadUpdate: () => Promise<AppUpdateInfo>;
    installUpdate: () => Promise<boolean>;
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
    now?: () => string;
}

type StateListener = (state: AppUpdateState) => void;

const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
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
    private readonly now: () => string;
    private initialized = false;
    private unlistenProgress: UnlistenFn | null = null;
    private checkRequestVersion = 0;

    constructor(deps: AppUpdateControllerDeps) {
        this.native = deps.native;
        this.settings = deps.settings;
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

        await this.settings.initialize();
        this.commit({
            type: 'settings-loaded',
            channel: this.settings.getChannel(),
            autoCheckEnabled: this.settings.getAutoCheckEnabled(),
            lastCheckedAt: this.settings.getLastCheckedAt(),
        });
        await this.listenForProgress();
        this.initialized = true;
    }

    async dispose(): Promise<void> {
        if (this.unlistenProgress) {
            this.unlistenProgress();
            this.unlistenProgress = null;
        }
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
        this.checkRequestVersion += 1;
        await this.settings.updateAppUpdateChannel(channel);
        await this.settings.updateAppUpdateLastCheckedAt(null);
        this.commit({ type: 'channel-updated', channel });
    }

    async checkNow(source: AppUpdateCheckSource = 'manual'): Promise<boolean> {
        await this.initialize();

        if (source === 'automatic' && !this.shouldRunAutomaticCheck()) {
            return false;
        }

        const previousState = this.state;
        const channel = this.state.channel;
        const requestVersion = ++this.checkRequestVersion;
        this.commit({ type: 'check-started', channel });

        try {
            const result = await this.native.checkForUpdates(channel);
            const checkedAt = this.now();
            if (!this.isCurrentCheckRequest(requestVersion, channel)) {
                return false;
            }

            this.commit({ type: 'check-completed', channel, result, checkedAt });
            await this.settings.updateAppUpdateLastCheckedAt(checkedAt);
            return true;
        } catch (error) {
            if (!this.isCurrentCheckRequest(requestVersion, channel)) {
                return false;
            }

            if (source === 'automatic') {
                this.replaceState(previousState);
                return false;
            }

            this.commit({ type: 'failed', error: toErrorMessage(error) });
            return false;
        }
    }

    async download(): Promise<boolean> {
        await this.initialize();
        this.commit({ type: 'download-started' });

        try {
            const update = await this.native.downloadUpdate();
            this.commit({ type: 'download-completed', update });
            return true;
        } catch (error) {
            this.commit({ type: 'failed', error: toErrorMessage(error) });
            return false;
        }
    }

    async install(): Promise<boolean> {
        await this.initialize();
        this.commit({ type: 'install-started' });

        try {
            await this.native.installUpdate();
            return true;
        } catch (error) {
            this.commit({ type: 'failed', error: toErrorMessage(error) });
            return false;
        }
    }

    private isCurrentCheckRequest(requestVersion: number, channel: AppUpdateChannel): boolean {
        return requestVersion === this.checkRequestVersion && this.state.channel === channel;
    }

    private shouldRunAutomaticCheck(): boolean {
        if (!this.state.autoCheckEnabled) {
            return false;
        }

        const lastCheckedAt = parseTime(this.state.lastCheckedAt);
        if (lastCheckedAt === null) {
            return true;
        }

        const now = parseTime(this.now());
        if (now === null) {
            return true;
        }

        return now - lastCheckedAt >= AUTO_CHECK_INTERVAL_MS;
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
            console.warn('[AppUpdateService] Failed to listen for update progress:', error);
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

export const appUpdateService = new AppUpdateController({
    native: native.updater,
    settings: createSettingsAdapter(),
});
