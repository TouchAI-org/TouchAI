// Copyright (c) 2026. 千诚. Licensed under GPL v3.

import { isLlmMetadataEmpty, syncAllModelsMetadata } from '@database/queries';
import { appUpdateService } from '@services/AppUpdateService';
import { completeManagedLogin, initializeManagedProviderState } from '@services/AuthService';
import {
    createManagedSettingsFocusRequest,
    persistManagedSettingsFocusRequest,
} from '@services/AuthService/managedSettingsFocus';
import { AppEvent, eventService } from '@services/EventService';
import { initializeLogger } from '@services/LoggerService';
import { native } from '@services/NativeService';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link';
import { openUrl } from '@tauri-apps/plugin-opener';
import { createPinia } from 'pinia';
import { createApp } from 'vue';

import App from './App.vue';
import { installI18n } from './i18n';
import router from './router';
import { updateModelMetadata } from './services/AgentService/infrastructure/modelMetadata';
import { useSettingsStore } from './stores/settings';
import { initializeFontLoader } from './utils/font';
import { isE2eTestMode } from './utils/runtimeMode';

const MANAGED_DEEP_LINK_WINDOW_LABEL = 'main';

function isInternalLink(url: string): boolean {
    if (!url || url === '#' || url.startsWith('#')) {
        return true;
    }

    if (!url.includes('://') && !url.startsWith('//')) {
        return true;
    }

    const currentOrigin = window.location.origin;
    try {
        const linkUrl = new URL(url, currentOrigin);
        return (
            linkUrl.origin === currentOrigin ||
            linkUrl.protocol === 'tauri:' ||
            linkUrl.protocol === 'asset:'
        );
    } catch {
        return false;
    }
}

function setupLinkInterceptor(): void {
    const handleLinkClick = (event: MouseEvent): void => {
        const target = event.target as HTMLElement;
        const anchor = target.closest('a');

        if (!anchor) {
            return;
        }

        const href = anchor.getAttribute('href');
        if (!href) {
            return;
        }

        if (isInternalLink(href)) {
            if (href.startsWith('/') && !href.startsWith('//')) {
                event.preventDefault();
                router.push(href);
            }
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        void openUrl(href);
    };

    const originalOpen = window.open;
    window.open = function (url?: string | URL, target?: string, features?: string): Window | null {
        const urlString = url?.toString() || '';

        if (!isInternalLink(urlString)) {
            void openUrl(urlString);
            return null;
        }

        return originalOpen.call(window, url, target, features);
    };

    document.addEventListener('click', handleLinkClick, true);
}

function scheduleAppUpdateChecks(): void {
    const runAutomaticCheck = () => {
        appUpdateService.checkNow('automatic').catch((error) => {
            console.warn('[AppUpdateService] Automatic update check failed:', error);
        });
    };

    runAutomaticCheck();
    window.setInterval(runAutomaticCheck, 60 * 60 * 1000);
}

async function notifyManagedAuthChanged(): Promise<void> {
    await eventService.emit(AppEvent.AI_MODELS_UPDATED, {
        updatedAt: Date.now(),
    });
}

async function focusManagedProviderSettings(): Promise<void> {
    const focusRequest = createManagedSettingsFocusRequest();
    persistManagedSettingsFocusRequest(focusRequest);

    try {
        await native.window.openSettingsWindow();
    } catch (error) {
        console.error('[AuthService] Failed to open settings window after managed login:', error);
    }

    await eventService.emit(AppEvent.SETTINGS_AI_SERVICES_FOCUS_PROVIDER, focusRequest);
}

async function consumeManagedAuthCallback(url: string): Promise<void> {
    const handled = await completeManagedLogin(url);
    if (!handled) {
        return;
    }
    await focusManagedProviderSettings();
    await notifyManagedAuthChanged();
}

function shouldHandleManagedDeepLinks(): boolean {
    try {
        return getCurrentWindow().label === MANAGED_DEEP_LINK_WINDOW_LABEL;
    } catch {
        return true;
    }
}

async function setupDeepLinkListener(): Promise<void> {
    if (!shouldHandleManagedDeepLinks()) {
        return;
    }

    try {
        const current = await getCurrent();
        for (const url of current || []) {
            await consumeManagedAuthCallback(url);
        }
    } catch (error) {
        console.warn('[AuthService] Failed to read current deep link URLs:', error);
    }

    try {
        await onOpenUrl(async (urls) => {
            for (const url of urls) {
                try {
                    await consumeManagedAuthCallback(url);
                } catch (error) {
                    console.error(
                        '[AuthService] Failed to complete managed login callback:',
                        error
                    );
                }
            }
        });
    } catch (error) {
        console.warn('[AuthService] Failed to register deep link listener:', error);
    }
}

async function initializeModelMetadata(): Promise<void> {
    try {
        if (await isE2eTestMode()) {
            return;
        }

        if (await isLlmMetadataEmpty()) {
            await updateModelMetadata();
            return;
        }

        await syncAllModelsMetadata();
    } catch (error) {
        console.warn('[Bootstrap] Failed to initialize model metadata:', error);
    }
}

export async function initializeApp() {
    initializeLogger();
    setupLinkInterceptor();
    document.addEventListener('contextmenu', (event) => event.preventDefault());
    initializeFontLoader();
    await initializeManagedProviderState();
    await initializeModelMetadata();
    await setupDeepLinkListener();

    const app = createApp(App);
    const pinia = createPinia();
    app.use(pinia);
    app.use(router);
    installI18n(app);

    let settingsInitializeError: unknown;
    try {
        await useSettingsStore(pinia).initialize();
    } catch (error) {
        settingsInitializeError = error;
    }

    app.mount('#app');

    if (settingsInitializeError) {
        console.error(
            'Failed to initialize persisted settings during bootstrap.',
            settingsInitializeError
        );
    }

    scheduleAppUpdateChecks();
}
