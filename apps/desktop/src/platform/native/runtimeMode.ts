import { log } from '@/platform/diagnostics';
import { native } from '@/platform/native';

let runtimeModePromise: Promise<boolean> | null = null;

async function loadIsE2eTestMode() {
    try {
        const runtimeInfo = await native.runtime.getRuntimeInfo();
        return runtimeInfo.isE2eTestMode;
    } catch (error) {
        log.warn('[RuntimeMode] Failed to load runtime mode, defaulting to normal mode:', error);
        return false;
    }
}

export function isE2eTestMode() {
    if (!runtimeModePromise) {
        runtimeModePromise = loadIsE2eTestMode();
    }

    return runtimeModePromise;
}
