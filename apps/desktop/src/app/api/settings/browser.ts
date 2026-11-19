import type { InstalledBrowser } from '@/modules/tools/public';

export type { InstalledBrowser } from '@/modules/tools/public';
export interface BrowserSettingsApi {
    discoverInstalledBrowsers(): Promise<InstalledBrowser[]>;
    getDefaultBrowserDataPath(): Promise<string>;
    pickBrowserDataPath(defaultPath?: string): Promise<string | null>;
    pickBrowserExecutable(defaultPath?: string): Promise<string | null>;
}
