// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3.

type StartupTask = () => Promise<unknown>;

export interface SearchViewStartupDependencies {
    initializeSettings: StartupTask;
    initializeMcpStore: StartupTask;
    initializePopups: StartupTask;
    syncWindowPinState: StartupTask;
    syncSearchWindowState: StartupTask;
    isE2eTestMode: () => Promise<boolean>;
    autoConnectMcp: StartupTask;
    onReady: (ready: boolean) => void;
    logError?: (message: string, error: unknown) => void;
}

function logStartupError(
    dependencies: SearchViewStartupDependencies,
    message: string,
    error: unknown
): void {
    dependencies.logError?.(message, error);
}

function runBackgroundTask(
    dependencies: SearchViewStartupDependencies,
    message: string,
    task: StartupTask
): void {
    task().catch((error) => {
        logStartupError(dependencies, message, error);
    });
}

async function startMcpAutoConnect(dependencies: SearchViewStartupDependencies): Promise<void> {
    if (await dependencies.isE2eTestMode()) {
        return;
    }

    await dependencies.autoConnectMcp();
}

export async function initializeSearchViewForFirstPaint(
    dependencies: SearchViewStartupDependencies
): Promise<void> {
    try {
        dependencies.onReady(false);
        await dependencies.initializeSettings();
        dependencies.onReady(true);

        runBackgroundTask(
            dependencies,
            '[SearchView] Failed to initialize MCP store:',
            dependencies.initializeMcpStore
        );
        runBackgroundTask(
            dependencies,
            '[SearchView] Failed to initialize popup service:',
            dependencies.initializePopups
        );
        runBackgroundTask(
            dependencies,
            '[SearchView] Failed to sync window pin state on initialize:',
            dependencies.syncWindowPinState
        );
        runBackgroundTask(
            dependencies,
            '[SearchView] Failed to sync search window state on initialize:',
            dependencies.syncSearchWindowState
        );
        runBackgroundTask(dependencies, '[SearchView] Failed to auto-connect MCP servers:', () =>
            startMcpAutoConnect(dependencies)
        );
    } catch (error) {
        logStartupError(dependencies, '[SearchView] Failed to initialize dependencies:', error);
        dependencies.onReady(false);
    }
}
