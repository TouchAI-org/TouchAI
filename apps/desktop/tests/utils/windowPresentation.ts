import { mockWindows } from '@tauri-apps/api/mocks';
import { config } from '@vue/test-utils';
import type { App } from 'vue';

import {
    diagnosticsAdminApiKey,
    glowWindowApiKey,
    searchWindowApiKey,
    settingsWindowApiKey,
    trayWindowApiKey,
    windowChromeApiKey,
} from '@/app/api/windows/presentation';
import type { initializeWindowPresentation } from '@/app/bootstrap/windowPresentation';

const windows = new Set<ReturnType<typeof initializeWindowPresentation>>();
export async function createTestWindowPresentation(label?: string) {
    const { initializeWindowPresentation } = await import('@/app/bootstrap/windowPresentation');
    if (label) mockWindows(label);
    const window = initializeWindowPresentation();
    windows.add(window);
    const entries = [
        [windowChromeApiKey, window.chrome],
        [searchWindowApiKey, window.search],
        [settingsWindowApiKey, window.settings],
        [trayWindowApiKey, window.tray],
        [glowWindowApiKey, window.glow],
        [diagnosticsAdminApiKey, window.diagnostics],
    ] as const;
    return {
        window,
        provide(app: App) {
            for (const [key, capability] of entries)
                if (capability) app.provide(key as symbol, capability);
        },
        install() {
            for (const [key, capability] of entries) {
                if (capability) Reflect.set(config.global.provide, key, capability);
                else Reflect.deleteProperty(config.global.provide, key);
            }
        },
    };
}

export function disposeTestWindowPresentations() {
    for (const window of windows) window.dispose();
    windows.clear();
}
