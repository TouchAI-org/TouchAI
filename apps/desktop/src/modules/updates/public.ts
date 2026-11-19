import type { AppUpdateChannel, AppUpdateState } from './types';

export {
    getAvailableAppUpdateVersion,
    getDownloadableAppUpdate,
    getInstallableAppUpdate,
} from './availability';
export { createInitialAppUpdateState } from './state';
export type * from './types';

export type AppUpdateCheckSource = 'manual' | 'automatic' | 'settings-open';
export interface UpdatesApi {
    getState(): AppUpdateState;
    subscribe(listener: (state: AppUpdateState) => void): () => void;
    initialize(): Promise<void>;
    checkNow(source?: AppUpdateCheckSource): Promise<boolean>;
    download(): Promise<boolean>;
    install(): Promise<boolean>;
    getVersion(): Promise<string>;
    openDownload(url: string): Promise<void>;
}
export interface UpdatePreferencesApi {
    setChannel(channel: AppUpdateChannel): Promise<void>;
    setAutoCheckEnabled(enabled: boolean): Promise<void>;
}
