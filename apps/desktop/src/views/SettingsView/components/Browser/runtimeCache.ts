import type { BrowserInstalledBrowser } from '@/services/NativeService/types';

let installedBrowsersCache: BrowserInstalledBrowser[] | null = null;
let installedBrowsersPromise: Promise<BrowserInstalledBrowser[]> | null = null;
let defaultBrowserDataPathCache: string | null = null;
let defaultBrowserDataPathPromise: Promise<string> | null = null;

export async function loadCachedInstalledBrowsers(
    loader: () => Promise<BrowserInstalledBrowser[]>,
    options: { force?: boolean } = {}
): Promise<BrowserInstalledBrowser[]> {
    if (!options.force && installedBrowsersCache) {
        return installedBrowsersCache;
    }

    if (installedBrowsersPromise) {
        return installedBrowsersPromise;
    }

    installedBrowsersPromise = loader()
        .then((browsers) => {
            installedBrowsersCache = browsers;
            return browsers;
        })
        .finally(() => {
            installedBrowsersPromise = null;
        });

    return installedBrowsersPromise;
}

export async function loadCachedDefaultBrowserDataPath(
    loader: () => Promise<string>
): Promise<string> {
    if (defaultBrowserDataPathCache) {
        return defaultBrowserDataPathCache;
    }

    if (defaultBrowserDataPathPromise) {
        return defaultBrowserDataPathPromise;
    }

    defaultBrowserDataPathPromise = loader()
        .then((path) => {
            defaultBrowserDataPathCache = path;
            return path;
        })
        .finally(() => {
            defaultBrowserDataPathPromise = null;
        });

    return defaultBrowserDataPathPromise;
}

export function resetBrowserRuntimeCacheForTests() {
    installedBrowsersCache = null;
    installedBrowsersPromise = null;
    defaultBrowserDataPathCache = null;
    defaultBrowserDataPathPromise = null;
}
