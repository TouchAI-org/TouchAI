import type { InstalledBrowser } from '@/app/api/settings/browser';

/** One cache for a window's settings projection; failed loads remain retryable. */
export function createBrowserRuntimeCache(input: {
    installed(): Promise<InstalledBrowser[]>;
    defaultDataPath(): Promise<string>;
}) {
    let browsers: InstalledBrowser[] | undefined;
    let browsersPending: Promise<InstalledBrowser[]> | undefined;
    let dataPath: string | undefined;
    let dataPathPending: Promise<string> | undefined;
    return {
        async installed(options: { force?: boolean } = {}) {
            if (!options.force && browsers) return browsers;
            return (browsersPending ??= input
                .installed()
                .then((value) => {
                    browsers = value;
                    return value;
                })
                .finally(() => {
                    browsersPending = undefined;
                }));
        },
        async defaultDataPath() {
            if (dataPath) return dataPath;
            return (dataPathPending ??= input
                .defaultDataPath()
                .then((value) => {
                    dataPath = value;
                    return value;
                })
                .finally(() => {
                    dataPathPending = undefined;
                }));
        },
    };
}
