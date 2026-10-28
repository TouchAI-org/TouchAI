<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import LoadingState from '@components/LoadingState.vue';
    import { useScrollbarStabilizer } from '@composables/useScrollbarStabilizer';
    import { useScrollFade } from '@composables/useScrollFade';
    import { appUpdateService } from '@services/AppUpdateService';
    import { AppEvent, eventService } from '@services/EventService';
    import { log } from '@services/ObservabilityService';
    import type { UnlistenFn } from '@tauri-apps/api/event';
    import { getCurrentWindow } from '@tauri-apps/api/window';
    import {
        type Component,
        type ComponentPublicInstance,
        computed,
        defineAsyncComponent,
        nextTick,
        onBeforeUnmount,
        onMounted,
        ref,
        watch,
    } from 'vue';

    import { locale, t } from '@/i18n';

    import GeneralView from './components/General/index.vue';
    import NavigationSidebar, {
        type NavigationSection,
        type ShowUpdateSettingsOptions,
    } from './components/NavigationSidebar.vue';
    import SettingsWindowTitleBar from './components/SettingsWindowTitleBar.vue';
    import { createSectionPreloader } from './sectionPreloader';
    import { captureScrollSnapshot, resolveRestoredScrollTop } from './sectionScrollMemory';
    import type { SettingsSearchResult } from './settingsSearch';

    defineOptions({
        name: 'SettingsWindowView',
    });

    const sectionLoaderBySection = new Map<
        NavigationSection,
        () => Promise<{ default: Component }>
    >();
    function defineSectionView(
        section: NavigationSection,
        loader: () => Promise<{ default: Component }>
    ) {
        sectionLoaderBySection.set(section, loader);
        return defineAsyncComponent(loader);
    }

    const ShortcutsView = defineSectionView(
        'shortcuts',
        () => import('./components/Shortcuts/index.vue')
    );
    const AiServicesView = defineSectionView(
        'ai-services',
        () => import('./components/AiServices/index.vue')
    );
    const UsageView = defineSectionView('usage', () => import('./components/Usage/index.vue'));
    const BuiltInToolsView = defineSectionView(
        'built-in-tools',
        () => import('./components/BuiltInTools/index.vue')
    );
    const SearchView = defineSectionView('search', () => import('./components/Search/index.vue'));
    const BrowserView = defineSectionView(
        'browser',
        () => import('./components/Browser/index.vue')
    );
    const McpToolsView = defineSectionView(
        'mcp-tools',
        () => import('./components/McpTools/index.vue')
    );
    const DataManagementView = defineSectionView(
        'data-management',
        () => import('./components/DataManagement/index.vue')
    );
    interface SettingsContentSection {
        component: Component;
        scrollable?: boolean;
    }

    function defineSettingsContentSections(
        sections: Record<NavigationSection, SettingsContentSection>
    ) {
        return sections;
    }

    const settingsContentSections = defineSettingsContentSections({
        general: {
            component: GeneralView,
            scrollable: true,
        },
        shortcuts: {
            component: ShortcutsView,
            scrollable: true,
        },
        'ai-services': {
            component: AiServicesView,
        },
        usage: {
            component: UsageView,
            scrollable: true,
        },
        'built-in-tools': {
            component: BuiltInToolsView,
        },
        search: {
            component: SearchView,
            scrollable: true,
        },
        browser: {
            component: BrowserView,
            scrollable: true,
        },
        'mcp-tools': {
            component: McpToolsView,
        },
        'data-management': {
            component: DataManagementView,
            scrollable: true,
        },
    });

    const activeSection = ref<NavigationSection>('general');
    const sectionPreloader = createSectionPreloader({
        load: async (section) => {
            await sectionLoaderBySection.get(section as NavigationSection)?.();
        },
        onError: (section, error) => {
            console.warn(`[SettingsView] Failed to preload section ${section}:`, error);
        },
    });

    function handlePrefetchSection(section: NavigationSection) {
        sectionPreloader.prefetch(section, { priority: true });
    }
    const uncachedSections = [
        'SettingsGeneralSection',
        'SettingsShortcutsSection',
        'SettingsSearchSection',
        'SettingsBrowserSection',
        'SettingsMcpToolsSection',
        'SettingsDataManagementSection',
    ];
    let preloadFrame: number | null = null;
    let unlistenSettingsOpened: UnlistenFn | null = null;
    let unlistenShowUpdates: UnlistenFn | null = null;
    let unmounted = false;
    const contentScrollRef = ref<HTMLElement | null>(null);
    const contentElementRef = ref<HTMLElement | null>(null);
    const activeViewRef = ref<ComponentPublicInstance | null>(null);
    const resolvedSection = ref<NavigationSection | null>(null);
    const pendingUpdateRequest = ref<ShowUpdateSettingsOptions | null>(null);
    let pendingSearchResult: SettingsSearchResult | null = null;
    let searchTargetObserver: MutationObserver | null = null;
    let searchTargetTimeout: ReturnType<typeof setTimeout> | null = null;
    const SEARCH_TARGET_TIMEOUT_MS = 5000;
    useScrollbarStabilizer(contentScrollRef);
    const { scrollFadeStyle } = useScrollFade(contentScrollRef);
    const activeContentSection = computed(() => settingsContentSections[activeSection.value]);
    // 每个设置分区各记一份滚动位置：容器只有一个，不记就会互相污染。
    const sectionScrollSnapshots = new Map<NavigationSection, number>();

    /** 记录当前分区的滚动位置（切走之前调用）。 */
    function rememberSectionScroll() {
        const snapshot = captureScrollSnapshot(contentElementRef.value);
        if (snapshot) {
            sectionScrollSnapshots.set(activeSection.value, snapshot.scrollTop);
        }
    }

    /** 切回分区时恢复它自己的滚动位置（或从顶部开始）。 */
    async function restoreSectionScroll(section: NavigationSection) {
        await nextTick();
        const element = contentElementRef.value;
        if (!element) {
            return;
        }

        element.scrollTop = resolveRestoredScrollTop(
            sectionScrollSnapshots.get(section),
            element.scrollHeight,
            element.clientHeight
        );
    }

    const currentWindow = (() => {
        try {
            return getCurrentWindow();
        } catch {
            return null;
        }
    })();

    const cancelPendingSearch = () => {
        pendingSearchResult = null;
        searchTargetObserver?.disconnect();
        searchTargetObserver = null;
        if (searchTargetTimeout !== null) clearTimeout(searchTargetTimeout);
        searchTargetTimeout = null;
    };

    const handleNavigate = (section: NavigationSection) => {
        cancelPendingSearch();
        pendingUpdateRequest.value = null;
        rememberSectionScroll();
        if (activeSection.value !== section) resolvedSection.value = null;
        activeSection.value = section;
        void restoreSectionScroll(section);
        sectionPreloader.prefetch(section, { priority: true });
    };

    const findSearchTarget = (result: SettingsSearchResult) =>
        result.targetId
            ? contentElementRef.value?.querySelector(
                  `[data-settings-search-target="${result.targetId}"]`
              )
            : null;

    const scrollToSearchResult = (result: SettingsSearchResult, target: Element | null) => {
        if (pendingSearchResult !== result || activeSection.value !== result.section) return;
        (target ?? contentScrollRef.value ?? contentElementRef.value)?.scrollIntoView({
            block: target ? 'center' : 'start',
            behavior: 'smooth',
        });
        cancelPendingSearch();
    };

    const locateSearchResult = (result: SettingsSearchResult) => {
        if (pendingSearchResult !== result || activeSection.value !== result.section) return;
        const target = findSearchTarget(result);
        if (target || !result.targetId) {
            scrollToSearchResult(result, target ?? null);
            return;
        }

        const content = contentElementRef.value;
        if (!content) return;
        searchTargetObserver?.disconnect();
        if (searchTargetTimeout !== null) clearTimeout(searchTargetTimeout);
        searchTargetObserver = new MutationObserver(() => {
            const appearedTarget = findSearchTarget(result);
            if (appearedTarget) scrollToSearchResult(result, appearedTarget);
        });
        searchTargetObserver.observe(content, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['data-settings-search-target'],
        });
        searchTargetTimeout = setTimeout(() => {
            scrollToSearchResult(result, null);
        }, SEARCH_TARGET_TIMEOUT_MS);

        const appearedTarget = findSearchTarget(result);
        if (appearedTarget) scrollToSearchResult(result, appearedTarget);
    };

    const handleSearchSelect = async (result: SettingsSearchResult) => {
        cancelPendingSearch();
        rememberSectionScroll();
        if (activeSection.value !== result.section) resolvedSection.value = null;
        pendingSearchResult = result;
        activeSection.value = result.section;
        await nextTick();

        if (pendingSearchResult === result && resolvedSection.value === result.section) {
            locateSearchResult(result);
        }
    };

    type UpdateSettingsView = ComponentPublicInstance & {
        checkAndOpenUpdates?: () => Promise<void> | void;
    };

    const invokePendingUpdateRequest = async () => {
        if (!pendingUpdateRequest.value || activeSection.value !== 'general') {
            return false;
        }

        const generalView = activeViewRef.value as UpdateSettingsView | null;
        const openUpdates = generalView?.checkAndOpenUpdates;
        if (!openUpdates) {
            return false;
        }

        pendingUpdateRequest.value = null;
        try {
            await openUpdates();
        } catch (error) {
            log.warn('[SettingsView] Failed to open update details:', error);
        }
        return true;
    };

    const handleContentResolved = async () => {
        const section = activeSection.value;
        await nextTick();
        if (section !== activeSection.value) return;

        resolvedSection.value = section;
        if (section === 'general') {
            void invokePendingUpdateRequest();
        }
        if (pendingSearchResult?.section === section) {
            locateSearchResult(pendingSearchResult);
        }
    };

    const scrollGeneralUpdateSectionIntoView = async (options?: ShowUpdateSettingsOptions) => {
        cancelPendingSearch();
        pendingUpdateRequest.value = options?.checkAndOpen ? options : null;
        activeSection.value = 'general';
        await nextTick();
        window.setTimeout(() => {
            if (unmounted || activeSection.value !== 'general') return;
            document.querySelector('[data-settings-update-section="true"]')?.scrollIntoView({
                block: 'start',
                behavior: 'smooth',
            });
        }, 0);
        void invokePendingUpdateRequest();
    };

    const setContentScrollElement = (element: Element | ComponentPublicInstance | null) => {
        contentElementRef.value = element instanceof HTMLElement ? element : null;
        contentScrollRef.value =
            activeContentSection.value.scrollable && element instanceof HTMLElement
                ? element
                : null;
    };

    function syncNativeWindowTitle() {
        if (!currentWindow?.setTitle) {
            return;
        }

        currentWindow.setTitle(`TouchAI - ${t('common.settings')}`).catch((error) => {
            log.error('[SettingsView] Failed to update native window title:', error);
        });
    }

    function checkForUpdatesOnOpen() {
        void appUpdateService.checkNow('settings-open').catch((error) => {
            log.warn('[SettingsView] Failed to check for updates:', error);
        });
    }

    onMounted(() => {
        syncNativeWindowTitle();
        checkForUpdatesOnOpen();
        if (new URLSearchParams(window.location.hash.split('?')[1]).get('section') === 'updates') {
            void scrollGeneralUpdateSectionIntoView({ checkAndOpen: true });
        }
        void eventService
            .on(AppEvent.SETTINGS_SHOW_UPDATES, () => {
                void scrollGeneralUpdateSectionIntoView({ checkAndOpen: true });
            })
            .then((unlisten) => {
                if (unmounted) unlisten();
                else unlistenShowUpdates = unlisten;
            })
            .catch((error) => {
                log.warn('[SettingsView] Failed to listen for update navigation:', error);
            });
        void eventService
            .on(AppEvent.SETTINGS_WINDOW_OPENED, checkForUpdatesOnOpen)
            .then((unlisten) => {
                if (unmounted) {
                    unlisten();
                } else {
                    unlistenSettingsOpened = unlisten;
                }
            })
            .catch((error) => {
                log.warn('[SettingsView] Failed to listen for settings opens:', error);
            });
        // Warm code after the shell renders, one section at a time at idle priority.
        // hover/focus prefetch can still jump ahead of this queue.
        preloadFrame = requestAnimationFrame(() => {
            preloadFrame = null;
            for (const section of sectionLoaderBySection.keys()) {
                sectionPreloader.prefetch(section);
            }
        });
    });

    watch(locale, syncNativeWindowTitle);

    onBeforeUnmount(() => {
        unmounted = true;
        cancelPendingSearch();
        unlistenSettingsOpened?.();
        unlistenShowUpdates?.();
        if (preloadFrame !== null) {
            cancelAnimationFrame(preloadFrame);
            preloadFrame = null;
        }
    });
</script>

<template>
    <div
        class="relative h-screen w-screen overflow-hidden bg-canvas-sunken font-serif text-compact"
        data-testid="settings-view"
    >
        <div class="flex h-full w-full flex-col overflow-hidden" data-testid="settings-shell-frame">
            <SettingsWindowTitleBar />

            <div class="flex min-h-0 min-w-0 flex-1 overflow-hidden">
                <NavigationSidebar
                    :active-section="activeSection"
                    @navigate="handleNavigate"
                    @prefetch-section="handlePrefetchSection"
                    @search-select="handleSearchSelect"
                    @show-update-settings="scrollGeneralUpdateSectionIntoView"
                />

                <main
                    class="relative my-2 mr-2 min-h-0 min-w-0 flex-1 overflow-hidden rounded-card border border-neutral-200/70 bg-white shadow-[0_10px_24px_rgba(15,23,42,0.03)]"
                    data-testid="settings-content-shell"
                >
                    <div
                        :ref="setContentScrollElement"
                        :class="[
                            't-page h-full w-full',
                            activeContentSection.scrollable
                                ? 'settings-scrollbar settings-scroll-fade overflow-y-auto'
                                : '',
                        ]"
                        :style="scrollFadeStyle"
                    >
                        <KeepAlive :exclude="uncachedSections">
                            <Suspense :timeout="0" @resolve="handleContentResolved">
                                <component
                                    :is="activeContentSection.component"
                                    :key="activeSection"
                                    ref="activeViewRef"
                                    v-on="
                                        activeSection === 'general'
                                            ? {
                                                  'show-update-settings':
                                                      scrollGeneralUpdateSectionIntoView,
                                              }
                                            : {}
                                    "
                                />
                                <template #fallback>
                                    <LoadingState variant="brand" fill="min" />
                                </template>
                            </Suspense>
                        </KeepAlive>
                    </div>
                </main>
            </div>
        </div>
    </div>
</template>
