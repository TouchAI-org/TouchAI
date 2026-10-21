<script setup lang="ts">
    import AlertMessage from '@components/AlertMessage.vue';
    import CustomSelect from '@components/CustomSelect.vue';
    import { Switch } from '@components/ui/switch';
    import { native } from '@services/NativeService';
    import { storeToRefs } from 'pinia';
    import { computed, onMounted, ref, watch } from 'vue';

    import {
        resolveSearchWindowDefaultSize,
        type SearchWindowSizePreset,
    } from '@/config/searchWindow';
    import { type AppLocale, LOCALE_LABELS, SUPPORTED_LOCALES, t } from '@/i18n';
    import { type OutputScrollBehavior, useSettingsStore } from '@/stores/settings';

    import UpdateAvailableBadge from './UpdateAvailableBadge.vue';
    import UpdateSettingsSection from './UpdateSettingsSection.vue';

    defineOptions({
        name: 'SettingsGeneralSection',
    });

    const emit = defineEmits<{
        (event: 'show-update-settings'): void;
    }>();

    const settingsStore = useSettingsStore();
    const { settings } = storeToRefs(settingsStore);

    const outputScrollBehaviorOptions = computed(
        (): Array<{
            value: OutputScrollBehavior;
            label: string;
            description: string;
        }> => [
            {
                value: 'follow_output',
                label: t('settings.general.outputScroll.follow'),
                description: t('settings.general.outputScroll.followDescription'),
            },
            {
                value: 'stay_position',
                label: t('settings.general.outputScroll.stay'),
                description: t('settings.general.outputScroll.stayDescription'),
            },
            {
                value: 'jump_to_top',
                label: t('settings.general.outputScroll.jumpToTop'),
                description: t('settings.general.outputScroll.jumpToTopDescription'),
            },
        ]
    );

    const searchWindowSizeOptions = computed(
        (): Array<{
            value: SearchWindowSizePreset;
            label: string;
        }> => [
            { value: 'small', label: t('settings.general.size.small') },
            { value: 'normal', label: t('settings.general.size.normal') },
            { value: 'large', label: t('settings.general.size.large') },
        ]
    );

    const languageOptions: Array<{
        value: AppLocale;
        label: string;
    }> = SUPPORTED_LOCALES.map((value) => ({
        value,
        label: LOCALE_LABELS[value],
    }));

    const pendingLanguage = ref<AppLocale>(settings.value.language);
    const alertMessage = ref<InstanceType<typeof AlertMessage> | null>(null);
    const updateSettingsSection = ref<InstanceType<typeof UpdateSettingsSection> | null>(null);

    async function checkAndOpenUpdates() {
        await updateSettingsSection.value?.checkAndOpenUpdates('settings-open');
    }

    defineExpose({ checkAndOpenUpdates });

    watch(
        () => settings.value.language,
        (language) => {
            pendingLanguage.value = language;
        },
        { immediate: true }
    );

    const loadSettings = async () => {
        try {
            await settingsStore.initialize();
        } catch (error) {
            console.error('Failed to load settings:', error);
            alertMessage.value?.error(t('settings.general.loadSettingsFailed'), 3000);
        }
    };

    const saveStartOnBoot = async () => {
        try {
            if (settings.value.startOnBoot) {
                await native.autostart.enableAutostart();
            } else {
                await native.autostart.disableAutostart();
            }

            await settingsStore.updateStartOnBoot(settings.value.startOnBoot);
        } catch (error) {
            console.error('Failed to save start_on_boot setting:', error);
            alertMessage.value?.error(t('settings.general.saveStartOnBootFailed'), 3000);
        }
    };

    const saveStartMinimized = async () => {
        try {
            await settingsStore.updateStartMinimized(settings.value.startMinimized);
        } catch (error) {
            console.error('Failed to save start_minimized setting:', error);
            alertMessage.value?.error(t('settings.general.saveSettingsFailed'), 3000);
        }
    };

    const saveOutputScrollBehavior = async () => {
        try {
            await settingsStore.updateOutputScrollBehavior(settings.value.outputScrollBehavior);
            alertMessage.value?.success(t('common.saved'), 2000);
        } catch (error) {
            console.error('Failed to save output_scroll_behavior setting:', error);
            alertMessage.value?.error(t('settings.general.saveSettingsFailed'), 3000);
        }
    };

    const saveSearchWindowSizePreset = async (preset: SearchWindowSizePreset) => {
        try {
            const size = resolveSearchWindowDefaultSize(preset);

            await settingsStore.updateSearchWindowSizePreset(preset);
            await native.window.setSearchWindowDefaults(size);

            alertMessage.value?.success(t('settings.general.searchWindowSizeUpdated'), 2000);
        } catch (error) {
            console.error('Failed to save search window size preset:', error);
            alertMessage.value?.error(t('settings.general.saveSearchWindowSizeFailed'), 3000);
        }
    };

    const saveLanguage = async (language: AppLocale) => {
        try {
            await settingsStore.updateLanguage(language);
            pendingLanguage.value = settings.value.language;
            alertMessage.value?.success(t('common.saved'), 2000);
        } catch (error) {
            console.error('Failed to save language setting:', error);
            alertMessage.value?.error(t('settings.general.saveLanguageFailed'), 3000);
            pendingLanguage.value = settings.value.language;
        }
    };

    onMounted(async () => {
        await loadSettings();

        try {
            const isEnabled = await native.autostart.isAutostartEnabled();
            if (isEnabled !== settings.value.startOnBoot) {
                settings.value.startOnBoot = isEnabled;
                await settingsStore.updateStartOnBoot(isEnabled);
            }
        } catch (error) {
            console.error('Failed to check autostart status:', error);
        }
    });
</script>

<template>
    <AlertMessage ref="alertMessage" />

    <div class="settings-page" data-testid="settings-general-section">
        <div data-testid="settings-general-layout" class="settings-section-stack">
            <header class="settings-page-header flex flex-wrap items-center justify-between gap-3">
                <h1 class="settings-page-title">{{ t('settings.nav.general.label') }}</h1>
                <UpdateAvailableBadge @click="emit('show-update-settings')" />
            </header>

            <section class="space-y-4">
                <div>
                    <h2 class="settings-section-title">
                        {{ t('settings.general.startupAndWindow') }}
                    </h2>
                    <p class="settings-section-description">
                        {{ t('settings.general.startupAndWindowDescription') }}
                    </p>
                </div>

                <div
                    data-testid="settings-general-card-launch"
                    class="settings-row-group divide-y divide-neutral-200/70"
                >
                    <div
                        data-settings-search-target="start-on-boot"
                        class="grid min-w-0 gap-4 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                    >
                        <div
                            data-testid="settings-general-row-label"
                            class="text-[13px] leading-6 font-normal text-neutral-900"
                        >
                            {{ t('settings.general.startOnBoot') }}
                        </div>
                        <Switch
                            size="lg"
                            :model-value="settings.startOnBoot"
                            @update:model-value="
                                settings.startOnBoot = !settings.startOnBoot;
                                saveStartOnBoot();
                            "
                        />
                    </div>

                    <div
                        data-settings-search-target="start-minimized"
                        class="grid min-w-0 gap-4 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                    >
                        <div
                            data-testid="settings-general-row-label"
                            class="text-[13px] leading-6 font-normal text-neutral-900"
                        >
                            {{ t('settings.general.startMinimized') }}
                        </div>
                        <Switch
                            size="lg"
                            data-testid="settings-start-minimized-toggle"
                            :model-value="settings.startMinimized"
                            @update:model-value="
                                settings.startMinimized = !settings.startMinimized;
                                saveStartMinimized();
                            "
                        />
                    </div>

                    <div
                        data-settings-search-target="window-size"
                        class="grid min-w-0 gap-4 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_180px] sm:items-center"
                    >
                        <label
                            data-testid="settings-general-row-label"
                            class="block text-[13px] leading-6 font-normal text-neutral-900"
                        >
                            {{ t('settings.general.windowSize') }}
                        </label>
                        <div data-testid="settings-general-control" class="ml-auto w-[180px]">
                            <CustomSelect
                                v-model="settings.searchWindowSizePreset"
                                :options="searchWindowSizeOptions"
                                @update:model-value="saveSearchWindowSizePreset"
                            />
                        </div>
                    </div>
                </div>
            </section>

            <section class="space-y-4">
                <div>
                    <h2 class="settings-section-title">
                        {{ t('settings.general.conversationExperience') }}
                    </h2>
                    <p class="settings-section-description">
                        {{ t('settings.general.conversationExperienceDescription') }}
                    </p>
                </div>

                <div data-testid="settings-general-card-conversation" class="settings-row-group">
                    <div
                        data-settings-search-target="output-scroll"
                        class="grid min-w-0 gap-4 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_180px] sm:items-center"
                    >
                        <label
                            data-testid="settings-general-row-label"
                            class="block text-[13px] leading-6 font-normal text-neutral-900"
                        >
                            {{ t('settings.general.outputScrollBehavior') }}
                        </label>
                        <div data-testid="settings-general-control" class="ml-auto w-[180px]">
                            <CustomSelect
                                v-model="settings.outputScrollBehavior"
                                :options="outputScrollBehaviorOptions"
                                @update:model-value="saveOutputScrollBehavior"
                            />
                        </div>
                    </div>
                </div>
            </section>

            <section class="space-y-4">
                <div>
                    <h2 class="settings-section-title">{{ t('settings.general.language') }}</h2>
                    <p class="settings-section-description">
                        {{ t('settings.general.languageDescription') }}
                    </p>
                </div>

                <div data-testid="settings-language-section" class="settings-row-group">
                    <div
                        data-settings-search-target="language"
                        class="grid min-w-0 gap-4 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_180px] sm:items-center"
                    >
                        <label
                            data-testid="settings-general-row-label"
                            class="block text-[13px] leading-6 font-normal text-neutral-900"
                        >
                            {{ t('settings.general.interfaceLanguage') }}
                        </label>
                        <div data-testid="settings-general-control" class="ml-auto w-[180px]">
                            <CustomSelect
                                v-model="pendingLanguage"
                                :options="languageOptions"
                                protect-option-text
                                @update:model-value="saveLanguage"
                            />
                        </div>
                    </div>
                </div>
            </section>

            <UpdateSettingsSection ref="updateSettingsSection" />
        </div>
    </div>
</template>
