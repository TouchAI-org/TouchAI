import { config } from '@vue/test-utils';
import { afterEach, beforeEach, vi } from 'vitest';

import { type PrivacyApi, privacyApiKey } from '@/app/api/privacy';
import { assemblePrivacyWindow } from '@/app/composition/privacy';
import { assembleSettingsWindow } from '@/app/composition/settings';

/** Real window owners; tests control only native IPC and the settings database. */
export async function createTestPrivacyWindow() {
    const { createPinia, disposePinia, setActivePinia } =
        await vi.importActual<typeof import('pinia')>('pinia');
    let preferences: ReturnType<typeof assembleSettingsWindow> | undefined;
    let privacy: ReturnType<typeof assemblePrivacyWindow> | undefined;
    const api = new Proxy({} as PrivacyApi, {
        get(_target, key) {
            if (!privacy) {
                preferences = assembleSettingsWindow('main');
                privacy = assemblePrivacyWindow(preferences.privacySettings);
            }
            return Reflect.get(privacy.api, key);
        },
    });
    const pinia = createPinia();
    setActivePinia(pinia);
    return {
        api,
        install() {
            Reflect.set(config.global.provide, privacyApiKey, api);
        },
        dispose() {
            disposePinia(pinia);
            privacy?.dispose();
            preferences?.dispose();
        },
    };
}

export function getTestPrivacyApi(): PrivacyApi {
    return Reflect.get(config.global.provide, privacyApiKey) as PrivacyApi;
}

/** Only conversation/privacy suites need this owner; unrelated tests must not load it. */
export function useTestPrivacyWindow() {
    let window: Awaited<ReturnType<typeof createTestPrivacyWindow>>;
    beforeEach(async () => {
        window = await createTestPrivacyWindow();
        window.install();
    });
    afterEach(() => {
        window?.dispose();
        Reflect.deleteProperty(config.global.provide, privacyApiKey);
    });
}
