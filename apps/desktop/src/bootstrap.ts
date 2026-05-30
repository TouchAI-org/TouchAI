// Copyright (c) 2026. 千诚. Licensed under GPL v3.

import { appUpdateService } from '@services/AppUpdateService';
import { initializeLogger } from '@services/LoggerService';
import { openUrl } from '@tauri-apps/plugin-opener';
import { createPinia } from 'pinia';
import { createApp } from 'vue';

import App from './App.vue';
import { installI18n } from './i18n';
import router from './router';
import { useSettingsStore } from './stores/settings';
import { initializeFontLoader } from './utils/font';

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

        openUrl(href).then(() => {});
    };

    const originalOpen = window.open;
    window.open = function (url?: string | URL, target?: string, features?: string): Window | null {
        const urlString = url?.toString() || '';

        if (!isInternalLink(urlString)) {
            openUrl(urlString).then(() => {});
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

/**
 * 初始化应用
 */
export async function initializeApp() {
    // 1. 初始化日志挂载
    initializeLogger();

    // 2. 启用链接拦截器（禁止外部链接跳转）
    setupLinkInterceptor();

    // 3. 禁止右键菜单（全局）
    document.addEventListener('contextmenu', (e) => e.preventDefault());

    // 4. 初始化字体加载监听器
    initializeFontLoader();

    // 5. 创建并挂载 Vue 应用
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
