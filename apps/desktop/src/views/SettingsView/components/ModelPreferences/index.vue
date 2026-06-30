<script setup lang="ts">
    import { useAlert } from '@composables/useAlert';
    import { storeToRefs } from 'pinia';
    import { onMounted, ref } from 'vue';

    import { t } from '@/i18n';
    import { useSettingsStore } from '@/stores/settings';

    import ModelPreferences from '../General/components/ModelPreferences.vue';

    defineOptions({
        name: 'SettingsModelPreferencesSection',
    });

    const settingsStore = useSettingsStore();
    const { settings } = storeToRefs(settingsStore);
    const alert = useAlert();
    const savingModelRoutingEnabled = ref(false);

    async function saveModelRoutingEnabled(previousValue: boolean) {
        if (savingModelRoutingEnabled.value) {
            return;
        }

        savingModelRoutingEnabled.value = true;
        try {
            await settingsStore.updateAllowModelAutoSwitch(settings.value.allowModelAutoSwitch);
            alert.success(t('common.saved'), 2000);
        } catch (error) {
            settings.value.allowModelAutoSwitch = previousValue;
            console.error('Failed to save allow_model_auto_switch setting:', error);
            alert.error(t('settings.general.modelPreferences.saveFailed'), 3000);
        } finally {
            savingModelRoutingEnabled.value = false;
        }
    }

    function toggleModelRoutingEnabled() {
        if (savingModelRoutingEnabled.value) {
            return;
        }

        const previousValue = settings.value.allowModelAutoSwitch;
        settings.value.allowModelAutoSwitch = !previousValue;
        void saveModelRoutingEnabled(previousValue);
    }

    onMounted(() => {
        void settingsStore.initialize();
    });
</script>

<template>
    <div class="settings-page" data-testid="settings-model-preferences-section">
        <div class="settings-section-stack">
            <header class="settings-page-header flex items-start gap-4">
                <div class="max-w-2xl min-w-0">
                    <h1 class="settings-page-title">
                        {{ t('settings.nav.modelPreferences.label') }}
                    </h1>
                    <p class="settings-section-description">
                        {{ t('settings.nav.modelPreferences.description') }}
                    </p>
                </div>
                <button
                    type="button"
                    data-testid="settings-model-routing-enabled-toggle"
                    :aria-label="t('settings.general.modelPreferences.enableRouting')"
                    :aria-pressed="settings.allowModelAutoSwitch"
                    :disabled="savingModelRoutingEnabled"
                    :class="[
                        'relative ml-auto inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
                        settings.allowModelAutoSwitch
                            ? 'settings-toggle-enabled'
                            : 'bg-neutral-200',
                    ]"
                    @click="toggleModelRoutingEnabled"
                >
                    <span
                        :class="[
                            'inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform',
                            settings.allowModelAutoSwitch ? 'translate-x-[18px]' : 'translate-x-1',
                        ]"
                    />
                </button>
            </header>

            <ModelPreferences :routing-enabled="settings.allowModelAutoSwitch" />
        </div>
    </div>
</template>
