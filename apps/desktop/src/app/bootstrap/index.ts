// Copyright (c) 2026. 千诚. Licensed under GPL v3.
import { getCurrentWindow } from '@tauri-apps/api/window';
import { openUrl } from '@tauri-apps/plugin-opener';
import { createPinia } from 'pinia';
import { createApp } from 'vue';

import App from '@/App.vue';
import { agentApiKey } from '@/app/api/agent';
import { analyticsPreferencesApiKey } from '@/app/api/analytics/preferences';
import { productAnalyticsApiKey } from '@/app/api/analytics/product';
import { clipboardDraftApiKey } from '@/app/api/attachments/drafts';
import { modelAdministrationApiKey } from '@/app/api/models/administration';
import { modelDiscoveryApiKey } from '@/app/api/models/discovery';
import { type ModelMetadataApi, modelMetadataApiKey } from '@/app/api/models/metadata';
import { searchApiKey } from '@/app/api/search/queries';
import { startupNoticesApiKey } from '@/app/api/search/startup';
import { dataManagementApiKey } from '@/app/api/settings/dataManagement';
import { everythingSetupApi, everythingSetupApiKey } from '@/app/api/settings/everything';
import { settingsApiKey } from '@/app/api/settings/preferences';
import { toolSettingsApiKey } from '@/app/api/settings/tools';
import { toolsAdministrationApiKey } from '@/app/api/tools/administration';
import { computerAdministrationApiKey } from '@/app/api/tools/computer';
import { mcpApiKey } from '@/app/api/tools/mcp';
import { mcpAdministrationApiKey } from '@/app/api/tools/mcpAdministration';
import { mainToolsStartupApiKey } from '@/app/api/tools/startup';
import { updatePreferencesApiKey, updatesApiKey } from '@/app/api/updates';
import {
    diagnosticsAdminApiKey,
    glowWindowApiKey,
    searchWindowApiKey,
    settingsWindowApiKey,
    trayWindowApiKey,
    windowChromeApiKey,
} from '@/app/api/windows/presentation';
import { isE2eTestMode } from '@/app/api/windows/runtime';
import { initializeAgentWindow } from '@/app/bootstrap/agent';
import { initializeSearchWindow } from '@/app/bootstrap/search';
import { installI18n } from '@/i18n';
import { log } from '@/platform/diagnostics';
import { initObservability } from '@/platform/diagnostics';
import { initializeFontLoader } from '@/platform/windows/font';
import router from '@/router';
import { useSettingsStore } from '@/stores/settings';

import { initializeWindowPresentation } from './windowPresentation';

const runUsageMaintenance = async (retentionDays = 0): Promise<void> => {
    const { runUsageMaintenance: run } = await import('@/modules/usage');
    await run(retentionDays);
};
const AUXILIARY_WINDOW_LABELS = new Set(['tray-menu', 'computer-use-glow']);
const AUXILIARY_ROUTE_PREFIXES = ['#/tray-menu', '#/computer-use-glow'];

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

    return AUXILIARY_WINDOW_LABELS.has(label);
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

/** Optional startup work does not delay paint; its lifetime ends with main. */
function scheduleModelMetadataRefresh(
    api: ModelMetadataApi,
    initialized: Promise<unknown>
): () => void {
    const lifetime = new AbortController();
    const runRefresh = () => {
        if (lifetime.signal.aborted) return;
        void api.refresh({ signal: lifetime.signal }).catch((error) => {
            if (!lifetime.signal.aborted)
                log.warn('[Bootstrap] Failed to refresh model metadata:', error);
        });
    };
    // A failed optional seed is already reported by the startup capability.
    void initialized.then(runRefresh, runRefresh);
    const timer = window.setInterval(runRefresh, MODEL_METADATA_REFRESH_INTERVAL_MS);
    return () => {
        lifetime.abort();
        window.clearInterval(timer);
    };
}

/**
 * 启动时跑一次用量维护（日汇总 + 按保留策略清理明细）。
 *
 * 读取用户的保留天数设置：0（默认）表示永不删。
 * 模块本身按需加载，不进入首屏启动路径。
 */
function scheduleUsageMaintenance(pinia: ReturnType<typeof createPinia>): void {
    try {
        const retentionDays = useSettingsStore(pinia).usageDetailRetentionDays;
        void runUsageMaintenance(retentionDays);
    } catch (error) {
        log.warn('[Bootstrap] Failed to schedule usage maintenance:', error);
    }
}

/**
 * 窗口卸载时释放设置所有者/客户端：所有者关闭会广播 `gone`，客户端据此快速失败，
 * 不会继续向已失效的所有者发请求。
 */
function registerSettingsDisposal(pinia: ReturnType<typeof createPinia>): void {
    const dispose = () => {
        void useSettingsStore(pinia).dispose();
    };
    window.addEventListener('beforeunload', dispose);
    window.addEventListener('pagehide', dispose);
}

export async function initializeApp() {
    // zone.js 必须在 initTracing() 选择 context manager 之前加载，否则 await 之后
    // 拿不到当前 span。Vitest 里导入它会改写定时器，所以只在真实 WebView 加载。
    let zoneLoadError: unknown;
    if (import.meta.env.MODE !== 'test') {
        try {
            await import('zone.js');
        } catch (error) {
            zoneLoadError = error;
        }
    }

    // 日志队列尽早启动，后续任何一步失败才有地方落盘。
    initObservability();
    if (zoneLoadError) {
        log.error(
            '[Bootstrap] Failed to load zone.js, trace context will not follow awaits:',
            zoneLoadError
        );
    }
    setupLinkInterceptor();
    document.addEventListener('contextmenu', (event) => event.preventDefault());

    const app = createApp(App);
    const pinia = createPinia();
    app.use(pinia);
    app.use(router);
    installI18n(app);
    const presentation = initializeWindowPresentation();
    if (presentation.chrome) app.provide(windowChromeApiKey, presentation.chrome);
    if (presentation.search) app.provide(searchWindowApiKey, presentation.search);
    if (presentation.settings) app.provide(settingsWindowApiKey, presentation.settings);
    if (presentation.tray) app.provide(trayWindowApiKey, presentation.tray);
    if (presentation.glow) app.provide(glowWindowApiKey, presentation.glow);
    if (presentation.diagnostics) app.provide(diagnosticsAdminApiKey, presentation.diagnostics);
    const agentWindow = initializeAgentWindow();
    const searchWindow = initializeSearchWindow(getCurrentWindowLabel());
    if (searchWindow.api) app.provide(searchApiKey, searchWindow.api);
    if (searchWindow.clipboard) app.provide(clipboardDraftApiKey, searchWindow.clipboard);
    app.provide(agentApiKey, agentWindow.api);
    if (agentWindow.startup) app.provide(startupNoticesApiKey, agentWindow.startup);
    app.provide(updatesApiKey, agentWindow.updates);
    if (agentWindow.updatePreferences)
        app.provide(updatePreferencesApiKey, agentWindow.updatePreferences);
    app.provide(productAnalyticsApiKey, agentWindow.productAnalytics);
    if (agentWindow.analyticsPreferences)
        app.provide(analyticsPreferencesApiKey, agentWindow.analyticsPreferences);
    app.provide(everythingSetupApiKey, everythingSetupApi);
    app.provide(settingsApiKey, agentWindow.settings);
    if (getCurrentWindowLabel() === 'settings' && agentWindow.toolSettings) {
        app.provide(modelAdministrationApiKey, agentWindow.modelAdministration!);
        app.provide(dataManagementApiKey, agentWindow.dataManagement!);
        app.provide(toolSettingsApiKey, agentWindow.toolSettings);
        app.provide(toolsAdministrationApiKey, agentWindow.tools);
        app.provide(computerAdministrationApiKey, agentWindow.computer);
        app.provide(mcpAdministrationApiKey, agentWindow.mcpAdministration!);
    }
    if (getCurrentWindowLabel() === 'main') {
        app.provide(mainToolsStartupApiKey, { autoConnectMcp: agentWindow.autoConnectMcp });
    }
    if (getCurrentWindowLabel() === 'main' || getCurrentWindowLabel() === 'settings') {
        app.provide(modelDiscoveryApiKey, agentWindow.models);
        app.provide(modelMetadataApiKey, agentWindow.metadata);
        app.provide(mcpApiKey, agentWindow.mcp);
    }
    let stopMetadataRefresh: (() => void) | undefined;
    const disposeAgent = () => {
        presentation.dispose();
        searchWindow.dispose();
        stopMetadataRefresh?.();
        stopMetadataRefresh = undefined;
        void agentWindow
            .dispose()
            .catch((error: unknown) => log.warn('[Bootstrap] Agent cleanup failed', error));
    };
    window.addEventListener('beforeunload', disposeAgent, { once: true });
    window.addEventListener('pagehide', disposeAgent, { once: true });

    if (shouldUseLightweightBootstrap()) {
        if (
            getCurrentWindowLabel() === 'computer-use-glow' ||
            window.location.hash.startsWith('#/computer-use-glow')
        ) {
            void initializeFontLoader();
        }
        app.mount('#app');
        // Keep tray motion preferences synchronized without delaying its first paint.
        void useSettingsStore(pinia)
            .initialize()
            .catch((error) => {
                log.warn('Failed to initialize auxiliary window preferences.', error);
            });
        return;
    }

    void initializeFontLoader();
    const settingsWindow = isSettingsWindow();

    let settingsInitializeError: unknown;
    try {
        await useSettingsStore(pinia).initialize();
    } catch (error) {
        settingsInitializeError = error;
    }

    // 先挂载输入外壳：语言/窗口策略就绪即可交互，不等后台能力准备。
    app.mount('#app');
    registerSettingsDisposal(pinia);

    if (settingsInitializeError) {
        log.error(
            'Failed to initialize persisted settings during bootstrap.',
            settingsInitializeError
        );
    }

    if (!settingsWindow && getCurrentWindowLabel() === 'main') {
        // 后台能力：工具补种、Bash 预热、元数据同步。
        // 启动阶段不 await；首帧后的请求由能力就绪门按需等待。
        const metadataInitialization = isE2eTestMode().then((testMode) =>
            testMode ? undefined : agentWindow.initializeModelMetadata()
        );
        agentWindow.capabilities.register('model-metadata', metadataInitialization);

        if (getCurrentWindowLabel() === 'main') {
            agentWindow.startAutomaticUpdateChecks();
        }
        stopMetadataRefresh = scheduleModelMetadataRefresh(
            agentWindow.metadata,
            metadataInitialization
        );
    }

    // 用量维护只读写数据库，与哪个窗口无关，但只需跑一次：
    // 内部已有节流，重开窗口不会重复汇总。
    scheduleUsageMaintenance(pinia);
}
