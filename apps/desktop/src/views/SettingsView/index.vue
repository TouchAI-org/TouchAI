<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import LoadingState from '@components/LoadingState.vue';
    import { useScrollbarStabilizer } from '@composables/useScrollbarStabilizer';
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

    import { locale, type MessageKey, t } from '@/i18n';

    import NavigationSidebar, { type NavigationSection } from './components/NavigationSidebar.vue';

    defineOptions({
        name: 'SettingsWindowView',
    });

    const GeneralView = defineAsyncComponent(() => import('./components/General/index.vue'));
    const ShortcutsView = defineAsyncComponent(() => import('./components/Shortcuts/index.vue'));
    const AiServicesView = defineAsyncComponent(() => import('./components/AiServices/index.vue'));
    const BuiltInToolsView = defineAsyncComponent(
        () => import('./components/BuiltInTools/index.vue')
    );
    const SearchView = defineAsyncComponent(() => import('./components/Search/index.vue'));
    const BrowserView = defineAsyncComponent(() => import('./components/Browser/index.vue'));
    const McpToolsView = defineAsyncComponent(() => import('./components/McpTools/index.vue'));
    const DataManagementView = defineAsyncComponent(
        () => import('./components/DataManagement/index.vue')
    );
    interface SettingsContentSection {
        component: Component;
        loadingKey: MessageKey;
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
            loadingKey: 'settings.loading.general',
            scrollable: true,
        },
        shortcuts: {
            component: ShortcutsView,
            loadingKey: 'settings.loading.shortcuts',
            scrollable: true,
        },
        'ai-services': {
            component: AiServicesView,
            loadingKey: 'settings.loading.aiServices',
        },
        'built-in-tools': {
            component: BuiltInToolsView,
            loadingKey: 'settings.loading.builtInTools',
        },
        search: {
            component: SearchView,
            loadingKey: 'settings.loading.search',
            scrollable: true,
        },
        browser: {
            component: BrowserView,
            loadingKey: 'settings.loading.browser',
            scrollable: true,
        },
        'mcp-tools': {
            component: McpToolsView,
            loadingKey: 'settings.loading.mcpTools',
        },
        'data-management': {
            component: DataManagementView,
            loadingKey: 'settings.loading.dataManagement',
            scrollable: true,
        },
    });

    const activeSection = ref<NavigationSection>('general');
    const sidebarReady = ref(false);
    const contentReady = ref(false);
    const minimumLoadingElapsed = ref(false);
    const initialLoadingVisible = ref(true);
    const SETTINGS_ENTRY_LOADING_DELAY_MS = 180;
    let loadingDelayTimer: ReturnType<typeof setTimeout> | null = null;
    const contentScrollRef = ref<HTMLElement | null>(null);
    const isWindowMaximized = ref(false);
    useScrollbarStabilizer(contentScrollRef);
    const shellVisibilityClass = computed(() =>
        initialLoadingVisible.value ? 'opacity-0' : 'opacity-100'
    );
    const activeContentSection = computed(() => settingsContentSections[activeSection.value]);

    const currentWindow = (() => {
        try {
            return getCurrentWindow();
        } catch {
            return null;
        }
    })();

    const handleNavigate = (section: NavigationSection) => {
        activeSection.value = section;
    };

    const scrollGeneralUpdateSectionIntoView = async () => {
        activeSection.value = 'general';
        await nextTick();
        window.setTimeout(() => {
            document.querySelector('[data-settings-update-section="true"]')?.scrollIntoView({
                block: 'start',
                behavior: 'smooth',
            });
        }, 0);
    };

    const completeInitialLoadingWhenReady = async () => {
        if (
            !initialLoadingVisible.value ||
            !sidebarReady.value ||
            !contentReady.value ||
            !minimumLoadingElapsed.value
        ) {
            return;
        }

        await nextTick();
        initialLoadingVisible.value = false;
    };

    const handleSidebarReady = () => {
        sidebarReady.value = true;
        void completeInitialLoadingWhenReady();
    };

    const handleContentResolved = () => {
        contentReady.value = true;
        void completeInitialLoadingWhenReady();
    };

    const setContentScrollElement = (element: Element | ComponentPublicInstance | null) => {
        contentScrollRef.value =
            activeContentSection.value.scrollable && element instanceof HTMLElement
                ? element
                : null;
    };

    const handleMinimize = async () => {
        await currentWindow?.minimize();
    };

    const handleToggleMaximize = async () => {
        if (!currentWindow) {
            return;
        }

        const maximized = await currentWindow.isMaximized();
        if (maximized) {
            await currentWindow.unmaximize();
            isWindowMaximized.value = false;
            return;
        }

        await currentWindow.maximize();
        isWindowMaximized.value = true;
    };

    const handleClose = async () => {
        await currentWindow?.close();
    };

    function syncNativeWindowTitle() {
        if (!currentWindow?.setTitle) {
            return;
        }

        currentWindow.setTitle(`TouchAI - ${t('common.settings')}`).catch((error) => {
            console.error('[SettingsView] Failed to update native window title:', error);
        });
    }

    /**
     * 设置窗口在页面内部准备数据库，入口脚本只负责窗口装载。
     */
    async function initialize() {
        try {
            await new Promise<void>((resolve) => {
                loadingDelayTimer = setTimeout(resolve, SETTINGS_ENTRY_LOADING_DELAY_MS);
            });
            minimumLoadingElapsed.value = true;
            await completeInitialLoadingWhenReady();
        } catch (error) {
            console.error('[SettingsView] Failed to initialize dependencies:', error);
            minimumLoadingElapsed.value = true;
        }
    }

    onMounted(() => {
        syncNativeWindowTitle();
        void initialize();
    });

    watch(locale, syncNativeWindowTitle);

    onBeforeUnmount(() => {
        if (loadingDelayTimer) {
            clearTimeout(loadingDelayTimer);
            loadingDelayTimer = null;
        }
    });
</script>

<template>
    <div
        class="relative h-screen w-screen overflow-hidden bg-[#f4f4f2] font-serif text-[13px]"
        data-testid="settings-view"
    >
        <div
            :class="['flex h-full w-full overflow-hidden', shellVisibilityClass]"
            data-testid="settings-shell-frame"
        >
            <NavigationSidebar
                :active-section="activeSection"
                @navigate="handleNavigate"
                @ready="handleSidebarReady"
                @show-update-settings="scrollGeneralUpdateSectionIntoView"
            />

            <div
                class="relative my-2 mr-2 min-w-0 flex-1 overflow-hidden rounded-[12px] border border-neutral-200/70 bg-white shadow-[0_10px_24px_rgba(15,23,42,0.03)]"
                data-testid="settings-shell-card"
            >
                <div class="flex h-full min-h-0 flex-col">
                    <div
                        class="absolute inset-x-0 top-0 z-10 h-9 shrink-0"
                        data-testid="settings-content-drag-region"
                        data-tauri-drag-region
                    />

                    <div
                        class="absolute top-2.5 right-3 z-20 flex items-center gap-1"
                        data-testid="settings-window-controls"
                    >
                        <button
                            type="button"
                            data-testid="settings-window-minimize"
                            data-tauri-drag-region="false"
                            class="flex h-7 w-7 cursor-pointer items-center justify-center rounded-[8px] text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700"
                            :title="t('window.minimize')"
                            :aria-label="t('window.minimize')"
                            @click="handleMinimize"
                        >
                            <AppIcon name="minimize" class="h-3.5 w-3.5" />
                        </button>

                        <button
                            type="button"
                            data-testid="settings-window-maximize"
                            data-tauri-drag-region="false"
                            class="flex h-7 w-7 cursor-pointer items-center justify-center rounded-[8px] text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700"
                            :title="isWindowMaximized ? t('window.restore') : t('window.maximize')"
                            :aria-label="
                                isWindowMaximized ? t('window.restore') : t('window.maximize')
                            "
                            @click="handleToggleMaximize"
                        >
                            <AppIcon
                                :name="isWindowMaximized ? 'restore-square' : 'maximize-square'"
                                class="h-3.5 w-3.5"
                                :class="isWindowMaximized ? '-scale-x-100' : ''"
                            />
                        </button>

                        <button
                            type="button"
                            data-testid="settings-window-close"
                            data-tauri-drag-region="false"
                            class="flex h-7 w-7 cursor-pointer items-center justify-center rounded-[8px] text-neutral-400 transition-colors hover:bg-red-50 hover:text-red-600"
                            :title="t('window.close')"
                            :aria-label="t('window.close')"
                            @click="handleClose"
                        >
                            <AppIcon name="close" class="h-3.5 w-3.5" />
                        </button>
                    </div>

                    <main
                        class="min-w-0 flex-1 overflow-hidden"
                        data-testid="settings-content-shell"
                    >
                        <div
                            :key="activeSection"
                            :ref="setContentScrollElement"
                            :class="[
                                'h-full w-full',
                                activeContentSection.scrollable
                                    ? 'settings-scrollbar overflow-y-auto'
                                    : '',
                            ]"
                        >
                            <Suspense @resolve="handleContentResolved">
                                <component :is="activeContentSection.component" />
                                <template #fallback>
                                    <LoadingState
                                        :message="t(activeContentSection.loadingKey)"
                                        variant="brand"
                                        fill="min"
                                    />
                                </template>
                            </Suspense>
                        </div>
                    </main>
                </div>
            </div>
        </div>

        <LoadingState
            v-if="initialLoadingVisible"
            class="absolute inset-0 z-50"
            variant="brand"
            fill="screen"
            data-testid="settings-loading-screen"
        />
    </div>
</template>
