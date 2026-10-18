<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import CustomSelect from '@components/CustomSelect.vue';
    import { computed, ref } from 'vue';

    import { t } from '@/i18n';
    import { useSettingsStore } from '@/stores/settings';

    defineOptions({ name: 'UsageRetention' });

    const settingsStore = useSettingsStore();
    const saving = ref(false);
    const saved = ref(false);

    const retentionOptions = computed(() =>
        [0, 30, 90, 365].map((days) => ({
            label:
                days === 0
                    ? t('settings.usage.retention.forever')
                    : t('settings.usage.retention.days', { days }),
            value: days,
        }))
    );

    async function handleChange(days: number) {
        saving.value = true;
        saved.value = false;
        try {
            await settingsStore.updateUsageDetailRetentionDays(days);
            saved.value = true;
            // 清理发生在下次启动的维护里，这里明确告知，避免用户以为立即生效
        } catch (error) {
            console.error('[UsageRetention] Failed to save retention setting:', error);
        } finally {
            saving.value = false;
        }
    }
</script>

<template>
    <section class="space-y-4">
        <div>
            <h2 class="settings-section-title">{{ t('settings.usage.retention.title') }}</h2>
            <p class="settings-section-description">
                {{ t('settings.usage.retention.description') }}
            </p>
        </div>

        <div class="settings-row-group">
            <div
                class="grid min-w-0 gap-4 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_180px] sm:items-center"
            >
                <div>
                    <div class="text-[13px] leading-6 text-neutral-900">
                        {{ t('settings.usage.retention.label') }}
                    </div>
                    <div class="mt-1 text-xs text-neutral-500">
                        {{ t('settings.usage.retention.hint') }}
                    </div>
                </div>
                <div class="ml-auto w-[180px]">
                    <CustomSelect
                        :model-value="settingsStore.usageDetailRetentionDays"
                        :options="retentionOptions"
                        :disabled="saving"
                        trigger-test-id="settings-usage-retention-trigger"
                        @update:model-value="handleChange"
                    />
                </div>
            </div>

            <p
                v-if="saved"
                class="border-t border-neutral-200/70 px-5 py-2 text-[11px] text-green-700"
            >
                {{ t('settings.usage.retention.saved') }}
            </p>
        </div>
    </section>
</template>
