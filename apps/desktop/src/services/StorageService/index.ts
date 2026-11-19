import { storage } from '@services/NativeService/storage';
import { log } from '@services/ObservabilityService';

export const storageService = {
    scan: () => storage.scan(),
    cleanup: (categories?: Parameters<typeof storage.cleanup>[0]) => storage.cleanup(categories),
    cleanupSelected: (selection: Parameters<typeof storage.cleanupSelected>[0]) =>
        storage.cleanupSelected(selection),
    compactDatabase: () => storage.compactDatabase(),
    clearHistory: (kind: Parameters<typeof storage.clearHistory>[0]) => storage.clearHistory(kind),
} as const;

interface SharedActivity {
    users: number;
    grant: Promise<string>;
}

let currentActivity: SharedActivity | null = null;

/** Nested draft/task/file work in one renderer shares a lease, not extra IPC round trips. */
export async function acquireStorageActivity(): Promise<() => Promise<void>> {
    const activity = currentActivity ?? { users: 0, grant: storage.hold() };
    currentActivity = activity;
    activity.users++;
    let activityId: string;
    try {
        activityId = await activity.grant;
    } catch (error) {
        activity.users--;
        if (currentActivity === activity && activity.users === 0) currentActivity = null;
        throw error;
    }
    let released = false;
    return async () => {
        if (released) return;
        released = true;
        activity.users--;
        if (activity.users !== 0) return;
        // A new acquire must never reuse a lease whose native release has already started.
        if (currentActivity === activity) currentActivity = null;
        await storage.release(activityId);
    };
}

export async function retainStoragePaths(paths: string[]): Promise<(() => Promise<void>) | null> {
    const unique = [...new Set(paths)];
    if (unique.length === 0) return null;
    const id = await storage.pinPaths(unique);
    let released = false;
    return async () => {
        if (released) return;
        await storage.release(id);
        released = true;
    };
}

export async function withStorageActivity<T>(operation: () => Promise<T>): Promise<T> {
    const release = await acquireStorageActivity();
    let value: T;
    try {
        value = await operation();
    } catch (error) {
        await release().catch((releaseError) => {
            // A failed release keeps cleanup blocked; preserve the operation's original failure.
            log.error('[Storage] Failed to release storage activity', releaseError);
        });
        throw error;
    }
    await release();
    return value;
}
