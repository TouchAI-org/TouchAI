// Copyright (c) 2026. 千诚. Licensed under GPL v3.

import { isLlmMetadataAliasEmpty, isLlmMetadataEmpty } from '@database/queries';
import { appUpdateService } from '@services/AppUpdateService';
import { initializeAppUpdateNotifications } from '@services/AppUpdateService/notifications';
import { getNextAppUpdateCheckAt, isWithinAppUpdateHours } from '@services/AppUpdateService/timing';
import { initializeLogger } from '@services/LoggerService';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { openUrl } from '@tauri-apps/plugin-opener';
import { createPinia } from 'pinia';
import { createApp } from 'vue';

import App from './App.vue';
import { installI18n } from './i18n';
import router from './router';
import { useSettingsStore } from './stores/settings';
import { initializeFontLoader } from './utils/font';

const AUXILIARY_WINDOW_LABELS = new Set(['tray-menu']);
const AUXILIARY_ROUTE_PREFIXES = ['#/popup', '#/tray-menu'];

/** 定时检查远端目录的间隔；是否真正请求由刷新入口按上次检查时间决定。 */
const MODEL_METADATA_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

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

function isSettingsWindow(): boolean {
    return (
        getCurrentWindowLabel() === 'settings' ||
        /^#\/settings(?:[/?]|$)/.test(window.location.hash)
    );
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
    const runAndScheduleNextCheck = async () => {
        const now = Date.now();
        if (isWithinAppUpdateHours(now)) {
            await appUpdateService.checkNow('automatic').catch((error) => {
                console.warn('[AppUpdateService] Automatic update check failed:', error);
            });
        }

        // The interval gate records completion time, so schedule from completion as well.
        const completedAt = Date.now();
        window.setTimeout(
            runAndScheduleNextCheck,
            getNextAppUpdateCheckAt(completedAt) - completedAt
        );
    };

    void initializeAppUpdateNotifications()
        .catch((error) => {
            console.warn('[AppUpdateService] Failed to initialize update notifications:', error);
        })
        .finally(runAndScheduleNextCheck);
}

/**
 * 落一份本地元数据，供界面启动后立即使用。
 *
 * 旧版本的缓存没有别名表，需要重新拉一次远端目录才能用上新匹配。
 */
async function initializeModelMetadata(): Promise<void> {
    try {
        if ((await isLlmMetadataEmpty()) || (await isLlmMetadataAliasEmpty())) {
            await seedBundledModelMetadata();
            return;
        }

        const { syncAllModelsMetadata } =
            await import('./services/AgentService/infrastructure/modelMetadata');
        await syncAllModelsMetadata();
    } catch (error) {
        console.warn('[Bootstrap] Failed to initialize model metadata:', error);
    }
}

/**
 * 启动后异步检查远端目录是否更新。
 *
 * 不阻塞挂载：检查走条件请求，上游没变时只推进检查时间。
 */
function scheduleModelMetadataRefresh(): void {
    const runRefresh = () => {
        void import('./services/AgentService/infrastructure/modelMetadata')
            .then(({ refreshModelMetadataIfStale }) => refreshModelMetadataIfStale())
            .catch((error) => {
                console.warn('[Bootstrap] Failed to refresh model metadata:', error);
            });
    };

    runRefresh();
    window.setInterval(runRefresh, MODEL_METADATA_REFRESH_INTERVAL_MS);
}

/**
 * 内置快照只是兜底数据，解析失败时不应阻断后续的远端刷新。
 */
async function seedBundledModelMetadata(): Promise<void> {
    try {
        const { seedModelMetadataFromSnapshot } =
            await import('./services/AgentService/infrastructure/modelMetadata');
        await seedModelMetadataFromSnapshot();
    } catch (error) {
        console.warn('[Bootstrap] Failed to seed bundled model metadata:', error);
    }
}

async function syncBuiltInTools(): Promise<void> {
    try {
        const { builtInToolService } = await import('./services/BuiltInToolService/service');
        await builtInToolService.syncRegisteredTools();
    } catch (error) {
        console.warn('[Bootstrap] Failed to sync built-in tools:', error);
    }
}

async function prewarmBuiltInBash(): Promise<void> {
    try {
        const { prewarmBashToolRuntime } =
            await import('./services/BuiltInToolService/tools/bash/helper');
        await prewarmBashToolRuntime();
    } catch (error) {
        console.warn('[Bootstrap] Failed to prewarm built-in Bash runtime:', error);
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
    const settingsWindow = isSettingsWindow();
    if (!settingsWindow) {
        await Promise.all([syncBuiltInTools(), prewarmBuiltInBash()]);
        await initializeModelMetadata();
    }

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

    if (!settingsWindow) {
        if (getCurrentWindowLabel() === 'main') {
            scheduleAppUpdateChecks();
        }
        scheduleModelMetadataRefresh();
    }
}
