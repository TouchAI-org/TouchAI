<!-- Copyright (c) 2025. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import ConfirmDialog from '@components/common/ConfirmDialog.vue';
    import TitleBar from '@components/common/TitleBar.vue';
    import AboutView from '@components/settings/AboutView.vue';
    import AiServicesView from '@components/settings/AiServicesView.vue';
    import DataManagement from '@components/settings/DataManagement.vue';
    import GeneralSettings from '@components/settings/GeneralSettings.vue';
    import NavigationSidebar, {
        type NavigationSection,
    } from '@components/settings/NavigationSidebar.vue';
    import { useConfirm } from '@composables/useConfirm';
    import { ref } from 'vue';

    const { confirmState, handleConfirm, handleCancel } = useConfirm();

    const activeSection = ref<NavigationSection>('general');

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
                    class="custom-scrollbar h-full overflow-y-auto"
                >
                    <GeneralSettings />
                </div>

                <AiServicesView v-if="activeSection === 'ai-services'" />

                <div
                    v-if="activeSection === 'data-management'"
                    class="custom-scrollbar h-full overflow-y-auto"
                >
                    <DataManagement />
                </div>

                <div
                    v-if="activeSection === 'about'"
                    class="custom-scrollbar h-full overflow-y-auto"
                >
                    <AboutView />
                </div>
            </div>
        </div>

        <ConfirmDialog
            v-if="confirmState.show"
            :title="confirmState.title"
            :message="confirmState.message"
            :confirm-text="confirmState.confirmText"
            :cancel-text="confirmState.cancelText"
            :type="confirmState.type"
            @confirm="handleConfirm"
            @cancel="handleCancel"
        />
    </div>
</template>
