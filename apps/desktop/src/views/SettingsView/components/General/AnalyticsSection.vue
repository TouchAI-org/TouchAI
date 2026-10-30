<script setup lang="ts">
    import SettingsRow from '@components/SettingsRow.vue';
    import { Button } from '@components/ui/button';
    import { Switch } from '@components/ui/switch';
    import { useAlert } from '@composables/useAlert';
    import { native } from '@services/NativeService';
    import type { AnalyticsState } from '@services/NativeService/types';
    import { log } from '@services/ObservabilityService';
    import { onMounted, ref } from 'vue';

    import { t } from '@/i18n';

    defineOptions({
        name: 'SettingsAnalyticsSection',
    });

    const alert = useAlert();
    const state = ref<AnalyticsState>({
        status: 'uninitialized',
        consentEpoch: 0,
        queueDepth: 0,
        pendingBytes: 0,
        transportReady: false,
    });

    async function load() {
        try {
            state.value = await native.analytics.getState();
        } catch (error) {
            log.error('[Analytics] Failed to load analytics state:', error);
        }
    }

    async function toggle(nextEnabled: boolean) {
        try {
            state.value = await native.analytics.setEnabled(nextEnabled, state.value.consentEpoch);
        } catch (error) {
            log.error('[Analytics] Failed to change analytics consent:', error);
            alert.error(t('settings.analytics.saveFailed'));
            await load();
        }
    }

    async function clearPending() {
        try {
            state.value = await native.analytics.clearPending(state.value.consentEpoch);
            alert.success(t('settings.analytics.cleared'), 2000);
        } catch (error) {
            log.error('[Analytics] Failed to clear pending analytics data:', error);
            alert.error(t('settings.analytics.saveFailed'));
        }
    }

    onMounted(load);
</script>

<template>
    <section class="space-y-4" data-settings-search-target="analytics">
        <h2 class="settings-section-title">{{ t('settings.analytics.title') }}</h2>

        <div class="settings-row-group divide-y divide-border-subtle">
            <SettingsRow
                data-settings-search-target="analytics-share"
                control-width="auto"
                :label="t('settings.analytics.share')"
            >
                <Switch
                    size="lg"
                    data-testid="settings-analytics-toggle"
                    :disabled="state.status === 'uninitialized'"
                    :model-value="state.status === 'enabled'"
                    @update:model-value="toggle"
                />
            </SettingsRow>

            <SettingsRow
                v-if="state.queueDepth > 0"
                data-settings-search-target="analytics-clear"
                control-width="auto"
                :label="t('settings.analytics.queue', { count: state.queueDepth })"
            >
                <Button
                    variant="outline-neutral"
                    class="ml-auto"
                    data-testid="settings-analytics-clear"
                    @click="clearPending"
                >
                    {{ t('settings.analytics.clearPending') }}
                </Button>
            </SettingsRow>
        </div>

        <p v-if="!state.transportReady" class="settings-section-description">
            {{ t('settings.analytics.transportUnavailable') }}
        </p>
        <p v-else class="settings-section-description">
            {{ t('settings.analytics.shareDescription') }}
        </p>
    </section>
</template>
