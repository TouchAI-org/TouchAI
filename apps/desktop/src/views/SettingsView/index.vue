<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import LoadingState from '@components/LoadingState.vue';
    import { useScrollbarStabilizer } from '@composables/useScrollbarStabilizer';
    import { getCurrentWindow } from '@tauri-apps/api/window';
    import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';

    import NavigationSidebar, { type NavigationSection } from './components/NavigationSidebar.vue';

    defineOptions({
        name: 'SettingsWindowView',
    });

    const GeneralView = defineAsyncComponent(() => import('./components/General/index.vue'));
    const AiServicesView = defineAsyncComponent(() => import('./components/AiServices/index.vue'));
    const BuiltInToolsView = defineAsyncComponent(
        () => import('./components/BuiltInTools/index.vue')
    );
    const McpToolsView = defineAsyncComponent(() => import('./components/McpTools/index.vue'));
    const DataManagementView = defineAsyncComponent(
        () => import('./components/DataManagement/index.vue')
    );
    const activeSection = ref<NavigationSection>('general');
    const sidebarReady = ref(false);
    const contentReady = ref(false);
    const minimumLoadingElapsed = ref(false);
    const initialLoadingVisible = ref(true);
    const SETTINGS_ENTRY_LOADING_DELAY_MS = 180;
    let loadingDelayTimer: ReturnType<typeof setTimeout> | null = null;
    const generalScrollRef = ref<HTMLElement | null>(null);
    const dataScrollRef = ref<HTMLElement | null>(null);
    const isWindowMaximized = ref(false);
    useScrollbarStabilizer(generalScrollRef);
    useScrollbarStabilizer(dataScrollRef);
    const shellVisibilityClass = computed(() =>
        initialLoadingVisible.value ? 'opacity-0' : 'opacity-100'
    );

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
        void initialize();
    });

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
                            title="最小化"
                            @click="handleMinimize"
                        >
                            <AppIcon name="minimize" class="h-3.5 w-3.5" />
                        </button>

                        <button
                            type="button"
                            data-testid="settings-window-maximize"
                            data-tauri-drag-region="false"
                            class="flex h-7 w-7 cursor-pointer items-center justify-center rounded-[8px] text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700"
                            :title="isWindowMaximized ? '还原' : '最大化'"
                            @click="handleToggleMaximize"
                        >
                            <AppIcon
                                :name="isWindowMaximized ? 'exit-fullscreen' : 'fullscreen'"
                                class="h-3.5 w-3.5"
                            />
                        </button>

                        <button
                            type="button"
                            data-testid="settings-window-close"
                            data-tauri-drag-region="false"
                            class="flex h-7 w-7 cursor-pointer items-center justify-center rounded-[8px] text-neutral-400 transition-colors hover:bg-red-50 hover:text-red-600"
                            title="关闭"
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
                            v-if="activeSection === 'general'"
                            ref="generalScrollRef"
                            :class="['settings-scrollbar', 'h-full w-full overflow-y-auto']"
                        >
                            <Suspense @resolve="handleContentResolved">
                                <GeneralView />
                                <template #fallback>
                                    <LoadingState variant="brand" fill="min" />
                                </template>
                            </Suspense>
                        </div>

                        <div v-else-if="activeSection === 'ai-services'" class="h-full w-full">
                            <Suspense>
                                <AiServicesView />
                                <template #fallback>
                                    <LoadingState variant="brand" fill="min" />
                                </template>
                            </Suspense>
                        </div>

                        <div v-else-if="activeSection === 'built-in-tools'" class="h-full w-full">
                            <Suspense>
                                <BuiltInToolsView />
                                <template #fallback>
                                    <LoadingState variant="brand" fill="min" />
                                </template>
                            </Suspense>
                        </div>

                        <div v-else-if="activeSection === 'mcp-tools'" class="h-full w-full">
                            <Suspense>
                                <McpToolsView />
                                <template #fallback>
                                    <LoadingState variant="brand" fill="min" />
                                </template>
                            </Suspense>
                        </div>

                        <div
                            v-else-if="activeSection === 'data-management'"
                            ref="dataScrollRef"
                            :class="['settings-scrollbar', 'h-full w-full overflow-y-auto']"
                        >
                            <Suspense>
                                <DataManagementView />
                                <template #fallback>
                                    <LoadingState variant="brand" fill="min" />
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
