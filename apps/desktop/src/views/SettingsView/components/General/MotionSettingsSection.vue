<script setup lang="ts">
    import AlertMessage from '@components/AlertMessage.vue';
    import CustomSelect from '@components/CustomSelect.vue';
    import SettingsRow from '@components/SettingsRow.vue';
    import { Switch } from '@components/ui/switch';
    import { log } from '@services/ObservabilityService';
    import { storeToRefs } from 'pinia';
    import { computed, ref } from 'vue';

    import { ANIMATION_SPEEDS, type AnimationSpeed } from '@/config/motion';
    import { t } from '@/i18n';
    import { useSettingsStore } from '@/stores/settings';

    const store = useSettingsStore();
    const { animationSpeed, automaticallyReduceMotion } = storeToRefs(store);
    const saving = ref(false);
    const alert = ref<InstanceType<typeof AlertMessage> | null>(null);
    const speedOptions = computed(() =>
        (Object.keys(ANIMATION_SPEEDS) as AnimationSpeed[]).map((value) => ({
            value,
            label: t(`settings.general.motion.${value}`),
        }))
    );

    async function save(update: () => Promise<void>) {
        if (saving.value) return;
        saving.value = true;
        try {
            await update();
        } catch (error) {
            log.error('Failed to save motion preference:', error);
            alert.value?.error(t('settings.general.saveSettingsFailed'), 3000);
        } finally {
            saving.value = false;
        }
    }
</script>

<template>
    <AlertMessage ref="alert" />
    <section class="space-y-4" data-testid="settings-motion-section">
        <h2 class="settings-section-title">{{ t('settings.general.motion.title') }}</h2>
        <div class="settings-row-group divide-y divide-border/70">
            <SettingsRow
                data-settings-search-target="animation-speed"
                control-width="180"
                label-as="label"
                label-for="animation-speed"
                :label="t('settings.general.motion.speed')"
            >
                <CustomSelect
                    id="animation-speed"
                    :model-value="animationSpeed"
                    :options="speedOptions"
                    :disabled="saving"
                    @update:model-value="(value) => save(() => store.updateAnimationSpeed(value))"
                />
            </SettingsRow>
            <SettingsRow
                data-settings-search-target="automatically-reduce-motion"
                control-width="auto"
                label-as="label"
                label-for="automatically-reduce-motion"
                :label="t('settings.general.motion.automatic')"
                :description="t('settings.general.motion.automaticDescription')"
            >
                <Switch
                    id="automatically-reduce-motion"
                    size="lg"
                    :model-value="automaticallyReduceMotion"
                    :disabled="saving"
                    @update:model-value="
                        (value) => save(() => store.updateAutomaticallyReduceMotion(value))
                    "
                />
            </SettingsRow>
        </div>
    </section>
</template>
