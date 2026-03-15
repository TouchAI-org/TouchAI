<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import LoadingState from '@components/LoadingState.vue';
    import TitleBar from '@components/TitleBar.vue';
    import { useScrollbarStabilizer } from '@composables/useScrollbarStabilizer';
    import { db } from '@database';
    import { defineAsyncComponent, onMounted, ref } from 'vue';

    import NavigationSidebar, { type NavigationSection } from './components/NavigationSidebar.vue';

    defineOptions({
        name: 'SettingsWindowView',
    });

    const GeneralView = defineAsyncComponent(() => import('./components/General/index.vue'));
    const AiServicesView = defineAsyncComponent(() => import('./components/AiServices/index.vue'));
    const McpToolsView = defineAsyncComponent(() => import('./components/McpTools/index.vue'));
    const DataManagementView = defineAsyncComponent(
        () => import('./components/DataManagement/index.vue')
    );
    const AboutView = defineAsyncComponent(() => import('./components/About/index.vue'));

    const activeSection = ref<NavigationSection>('general');
    const viewReady = ref(false);
    const generalScrollRef = ref<HTMLElement | null>(null);
    const dataScrollRef = ref<HTMLElement | null>(null);
    const aboutScrollRef = ref<HTMLElement | null>(null);
    useScrollbarStabilizer(generalScrollRef);
    useScrollbarStabilizer(dataScrollRef);
    useScrollbarStabilizer(aboutScrollRef);

    const handleNavigate = (section: NavigationSection) => {
        activeSection.value = section;
    };

    /**
     * 设置窗口需要在页面内部准备数据库，这样入口脚本不再按窗口标签承担初始化分流。
     */
    async function initialize() {
        try {
            viewReady.value = false;
            await db.init();
            viewReady.value = true;
        } catch (error) {
            console.error('[SettingsView] Failed to initialize dependencies:', error);
            viewReady.value = false;
        }
    }

    onMounted(() => {
        void initialize();
    });
</script>

<template>
    <div class="bg-background-primary flex h-screen w-screen flex-col">
        <TitleBar title="设置" />

        <div class="flex flex-1 overflow-hidden">
            <NavigationSidebar :active-section="activeSection" @navigate="handleNavigate" />

            <div class="flex-1 overflow-hidden">
                <div
                    v-if="viewReady && activeSection === 'general'"
                    ref="generalScrollRef"
                    class="custom-scrollbar h-full overflow-y-auto"
                >
                    <Suspense>
                        <GeneralView />
                        <template #fallback>
                            <LoadingState message="正在加载常规设置..." fill="min" />
                        </template>
                    </Suspense>
                </div>

                <div v-else-if="viewReady && activeSection === 'ai-services'" class="h-full">
                    <Suspense>
                        <AiServicesView />
                        <template #fallback>
                            <LoadingState message="正在加载大模型服务设置..." />
                        </template>
                    </Suspense>
                </div>

                <div v-else-if="viewReady && activeSection === 'mcp-tools'" class="h-full">
                    <Suspense>
                        <McpToolsView />
                        <template #fallback>
                            <LoadingState message="正在加载 MCP 工具..." />
                        </template>
                    </Suspense>
                </div>

                <div
                    v-else-if="viewReady && activeSection === 'data-management'"
                    ref="dataScrollRef"
                    class="custom-scrollbar h-full overflow-y-auto"
                >
                    <Suspense>
                        <DataManagementView />
                        <template #fallback>
                            <LoadingState message="正在加载数据管理..." fill="min" />
                        </template>
                    </Suspense>
                </div>

                <div
                    v-else-if="viewReady && activeSection === 'about'"
                    ref="aboutScrollRef"
                    class="custom-scrollbar h-full overflow-y-auto"
                >
                    <Suspense>
                        <AboutView />
                        <template #fallback>
                            <LoadingState message="正在加载关于页面..." fill="min" />
                        </template>
                    </Suspense>
                </div>
            </div>
        </div>
    </div>
</template>
