// Copyright (c) 2026. 千诚. Licensed under GPL v3.
import { isLlmMetadataAliasEmpty, isLlmMetadataEmpty } from '@database/queries';
import { appUpdateService } from '@services/AppUpdateService';
import { initializeAppUpdateNotifications } from '@services/AppUpdateService/notifications';
import { getNextAppUpdateCheckAt, isWithinAppUpdateHours } from '@services/AppUpdateService/timing';
import { log } from '@services/ObservabilityService';
import { initObservability } from '@services/ObservabilityService';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { openUrl } from '@tauri-apps/plugin-opener';
import { createPinia } from 'pinia';
import { createApp } from 'vue';

import App from './App.vue';
import { installI18n } from './i18n';
import router from './router';
import { registerStartupCapability } from './services/StartupService/capabilities';
import { useSettingsStore } from './stores/settings';
import { initializeFontLoader } from './utils/font';
import { isE2eTestMode } from './utils/runtimeMode';

const runUsageMaintenance = async (retentionDays = 0): Promise<void> => {
    const { runUsageMaintenance: run } = await import('./services/UsageService/maintenance');
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

let stopAppUpdateChecks: (() => void) | null = null;

function scheduleAppUpdateChecks(): void {
    stopAppUpdateChecks?.();
    let stopped = false;
    let running = false;
    let timer: number | null = null;
    const runAndScheduleNextCheck = async () => {
        if (stopped || running) return;
        if (timer !== null) window.clearTimeout(timer);
        timer = null;
        running = true;
        const now = Date.now();
        const checked = isWithinAppUpdateHours(now)
            ? await appUpdateService.checkNow('automatic').catch((error) => {
                  log.warn('[AppUpdateService] Automatic update check failed:', error);
                  return false;
              })
            : false;
        running = false;
        if (stopped) return;
        if (!checked) {
            // A skipped check (interval not reached, offline, outside hours) or a
            // failed check must keep the existing deadline, not restart it. A
            // deadline that already passed falls back to the next allowed window
            // so a stale timestamp cannot create a zero-delay retry loop.
            const interval = appUpdateService.getAutomaticCheckInterval();
            const attemptAt = Date.parse(appUpdateService.getLastCheckAttemptAt() ?? '');
            const hasLiveDeadline =
                isWithinAppUpdateHours(now) &&
                Number.isFinite(attemptAt) &&
                attemptAt + interval > now;
            const referenceAt = hasLiveDeadline ? attemptAt : now;
            let retryAt = getNextAppUpdateCheckAt(referenceAt, interval);
            if (retryAt <= now) {
                // Quiet hours clamp a 07:30 reference to 08:00, which can equal
                // "now" the moment the skipped check finishes. Re-arm at the
                // next full window instead of spinning on a zero-delay timer.
                retryAt = getNextAppUpdateCheckAt(now, interval);
            }
            timer = window.setTimeout(runAndScheduleNextCheck, Math.max(0, retryAt - now));
            return;
        }

        // The interval gate records completion time, so schedule from completion as well.
        const completedAt = Date.now();
        timer = window.setTimeout(
            runAndScheduleNextCheck,
            getNextAppUpdateCheckAt(completedAt, appUpdateService.getAutomaticCheckInterval()) -
                completedAt
        );
    };

    const onOnline = () => {
        void runAndScheduleNextCheck();
    };
    const stop = () => {
        stopped = true;
        if (timer !== null) window.clearTimeout(timer);
        window.removeEventListener('online', onOnline);
        window.removeEventListener('pagehide', stop);
        stopAppUpdateChecks = null;
    };
    stopAppUpdateChecks = stop;
    window.addEventListener('online', onOnline);
    window.addEventListener('pagehide', stop, { once: true });

    void initializeAppUpdateNotifications()
        .catch((error) => {
            log.warn('[AppUpdateService] Failed to initialize update notifications:', error);
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
            await import('@/services/AgentService/infrastructure/modelMetadata/syncEntry');
        await syncAllModelsMetadata();
    } catch (error) {
        log.warn('[Bootstrap] Failed to initialize model metadata:', error);
    }
}

/**
 * 启动后异步检查远端目录是否更新。
 *
 * 不阻塞挂载：检查走条件请求，上游没变时只推进检查时间。
 */
function scheduleModelMetadataRefresh(): void {
    const runRefresh = () => {
        void import('@/services/AgentService/infrastructure/modelMetadata/syncEntry')
            .then(({ refreshModelMetadataIfStale }) => refreshModelMetadataIfStale())
            .catch((error) => {
                log.warn('[Bootstrap] Failed to refresh model metadata:', error);
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
            await import('@/services/AgentService/infrastructure/modelMetadata/seed');
        await seedModelMetadataFromSnapshot();
    } catch (error) {
        log.warn('[Bootstrap] Failed to seed bundled model metadata:', error);
    }
}

async function syncBuiltInTools(): Promise<void> {
    try {
        const { builtInToolService } = await import('./services/BuiltInToolService/service');
        await builtInToolService.syncRegisteredTools();
    } catch (error) {
        log.warn('[Bootstrap] Failed to sync built-in tools:', error);
    }
}

async function prewarmBuiltInBash(): Promise<void> {
    try {
        const { prewarmBashToolRuntime } =
            await import('./services/BuiltInToolService/tools/bash/helper');
        await prewarmBashToolRuntime();
    } catch (error) {
        log.warn('[Bootstrap] Failed to prewarm built-in Bash runtime:', error);
    }
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
    const isMainWindow = getCurrentWindowLabel() === 'main';

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

    if (!settingsWindow && isMainWindow) {
        // 后台能力：工具补种、Bash 预热、元数据同步。
        // 启动阶段不 await；首帧后的请求由能力就绪门按需等待。
        registerStartupCapability('built-in-tools', syncBuiltInTools());
        registerStartupCapability('built-in-bash', prewarmBuiltInBash());
        registerStartupCapability(
            'model-metadata',
            isE2eTestMode().then((testMode) => (testMode ? undefined : initializeModelMetadata()))
        );

        if (getCurrentWindowLabel() === 'main') {
            scheduleAppUpdateChecks();
        }
        scheduleModelMetadataRefresh();
    }

    // 用量维护会写用量明细，数据库权限模型只允许 main 窗口执行。
    // Settings/预览/未知窗口必须保持只读，不能在这里触发 UsageWrite。
    if (!settingsWindow && isMainWindow) {
        scheduleUsageMaintenance(pinia);
    }
}
