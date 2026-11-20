import { native } from '@/platform/native';

import type { InstalledBrowser } from '../../contracts/browser';

export async function discoverInstalledBrowsers(): Promise<InstalledBrowser[]> {
    return (await native.browser.discoverInstalled()).map(({ id, name, path }) => ({
        id,
        name,
        path,
    }));
}
export function getDefaultBrowserDataPath(): Promise<string> {
    return native.browser.defaultDataPath();
}
