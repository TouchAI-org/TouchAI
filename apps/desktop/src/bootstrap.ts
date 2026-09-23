// Copyright (c) 2026. 千诚. Licensed under GPL v3.

import { isLlmMetadataEmpty, syncAllModelsMetadata } from '@database/queries';
import { appUpdateService } from '@services/AppUpdateService';
import { initializeLogger } from '@services/LoggerService';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { openUrl } from '@tauri-apps/plugin-opener';
import { createPinia } from 'pinia';
import { createApp } from 'vue';

import App from './App.vue';
import { installI18n } from './i18n';
import router from './router';
import { updateModelMetadata } from './services/AgentService/infrastructure/modelMetadata';
import { builtInToolService } from './services/BuiltInToolService/service';
import { useSettingsStore } from './stores/settings';
import { initializeFontLoader } from './utils/font';

const AUXILIARY_WINDOW_LABELS = new Set(['tray-menu']);
const AUXILIARY_ROUTE_PREFIXES = ['#/popup', '#/tray-menu'];

function getCurrentWindowLabel(): string | null {
    try {
        return getCurrentWindow().label;
    } catch {
        return null;
    }
}

function isAuxiliaryWindowLabel(label: string | null): boolean {
    if (!label) {
        return false;
    }

    return AUXILIARY_WINDOW_LABELS.has(label) || label.startsWith('popup-');
}

function isAuxiliaryRoute(): boolean {
    return AUXILIARY_ROUTE_PREFIXES.some((prefix) => window.location.hash.startsWith(prefix));
}

function shouldUseLightweightBootstrap(): boolean {
    return isAuxiliaryWindowLabel(getCurrentWindowLabel()) || isAuxiliaryRoute();
}

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

async function initializeModelMetadata(): Promise<void> {
    try {
        if (await isLlmMetadataEmpty()) {
            await updateModelMetadata();
            return;
        }

        await syncAllModelsMetadata();
    } catch (error) {
        console.warn('[Bootstrap] Failed to initialize model metadata:', error);
    }
}

async function syncBuiltInTools(): Promise<void> {
    try {
        await builtInToolService.syncRegisteredTools();
    } catch (error) {
        console.warn('[Bootstrap] Failed to sync built-in tools:', error);
    }
}

export async function initializeApp() {
    initializeLogger();
    setupLinkInterceptor();
    document.addEventListener('contextmenu', (event) => event.preventDefault());

    const app = createApp(App);
    const pinia = createPinia();
    app.use(pinia);
    app.use(router);
    installI18n(app);

    if (shouldUseLightweightBootstrap()) {
        app.mount('#app');
        return;
    }

    initializeFontLoader();
    await syncBuiltInTools();
    await initializeModelMetadata();

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
