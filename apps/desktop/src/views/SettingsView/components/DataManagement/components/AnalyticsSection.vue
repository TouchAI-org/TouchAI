<script setup lang="ts">
    import SettingsRow from '@components/SettingsRow.vue';
    import { Switch } from '@components/ui/switch';
    import { onMounted, onUnmounted, ref } from 'vue';

    import {
        type AnalyticsChoice,
        useAnalyticsPreferencesApi,
    } from '@/app/api/analytics/preferences';
    import { log } from '@/app/api/diagnostics';
    import { t } from '@/i18n';

    defineOptions({
        name: 'SettingsAnalyticsSection',
    });

    const api = useAnalyticsPreferencesApi();
    let disposed = false;
    const state = ref<AnalyticsChoice>({
        status: 'uninitialized',
        consentEpoch: 0,
        canEnable: false,
    });

    async function load() {
        try {
            const next = await api.getChoice();
            if (!disposed) state.value = next;
        } catch (error) {
            log.error('[Analytics] Failed to load analytics state:', error);
        }
    }

    async function toggle(nextEnabled: boolean) {
        try {
            const next = await api.setEnabled(nextEnabled, state.value.consentEpoch);
            if (!disposed) state.value = next;
        } catch (error) {
            log.error('[Analytics] Failed to change analytics consent:', error);
            if (!disposed) await load();
        }
    }

    onMounted(load);
    onUnmounted(() => {
        disposed = true;
    });
</script>

<template>
    <section class="space-y-4" data-settings-search-target="analytics">
        <h2 class="settings-section-title">{{ t('settings.analytics.title') }}</h2>

        <div class="settings-row-group divide-y divide-border-subtle">
            <SettingsRow
                data-settings-search-target="analytics-share"
                data-testid="settings-analytics-share"
                control-width="auto"
                :label="t('settings.analytics.share')"
                :description="t('settings.analytics.shareDescription')"
            >
                <Switch
                    size="lg"
                    data-testid="settings-analytics-toggle"
                    :disabled="
                        state.status === 'uninitialized' ||
                        (state.status !== 'enabled' && !state.canEnable)
                    "
                    :model-value="state.status === 'enabled'"
                    @update:model-value="toggle"
                />
            </SettingsRow>
        </div>
    </section>
</template>
