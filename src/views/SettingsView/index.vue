<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import TitleBar from '@components/TitleBar.vue';
    import { useScrollbarStabilizer } from '@composables/useScrollbarStabilizer';
    import { ref } from 'vue';

    import AboutView from './components/About/index.vue';
    import AiServicesView from './components/AiServices/index.vue';
    import DataManagementView from './components/DataManagement/index.vue';
    import GeneralView from './components/General/index.vue';
    import McpToolsView from './components/McpTools/index.vue';
    import NavigationSidebar, { type NavigationSection } from './components/NavigationSidebar.vue';

    defineOptions({
        name: 'SettingsWindowView',
    });

    const activeSection = ref<NavigationSection>('general');
    const generalScrollRef = ref<HTMLElement | null>(null);
    const dataScrollRef = ref<HTMLElement | null>(null);
    const aboutScrollRef = ref<HTMLElement | null>(null);
    useScrollbarStabilizer(generalScrollRef);
    useScrollbarStabilizer(dataScrollRef);
    useScrollbarStabilizer(aboutScrollRef);

    const handleNavigate = (section: NavigationSection) => {
        activeSection.value = section;
    };
</script>

<template>
    <div class="bg-background-primary flex h-screen w-screen flex-col">
        <TitleBar title="设置" />

        <div class="flex flex-1 overflow-hidden">
            <NavigationSidebar :active-section="activeSection" @navigate="handleNavigate" />

            <div class="flex-1 overflow-hidden">
                <div
                    v-if="activeSection === 'general'"
                    ref="generalScrollRef"
                    class="custom-scrollbar h-full overflow-y-auto"
                >
                    <GeneralView />
                </div>

                <AiServicesView v-if="activeSection === 'ai-services'" />

                <McpToolsView v-if="activeSection === 'mcp-tools'" />

                <div
                    v-if="activeSection === 'data-management'"
                    ref="dataScrollRef"
                    class="custom-scrollbar h-full overflow-y-auto"
                >
                    <DataManagementView />
                </div>

                <div
                    v-if="activeSection === 'about'"
                    ref="aboutScrollRef"
                    class="custom-scrollbar h-full overflow-y-auto"
                >
                    <AboutView />
                </div>
            </div>
        </div>
    </div>
</template>
