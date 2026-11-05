<script setup lang="ts">
    import SettingsRow from '@components/SettingsRow.vue';
    import { Switch } from '@components/ui/switch';
    import { native } from '@services/NativeService';
    import type { AnalyticsState } from '@services/NativeService/types';
    import { log } from '@services/ObservabilityService';
    import { onMounted, ref } from 'vue';

    import { t } from '@/i18n';

    defineOptions({
        name: 'SettingsAnalyticsSection',
    });

    const state = ref<AnalyticsState>({
        status: 'uninitialized',
        consentEpoch: 0,
        queueDepth: 0,
        pendingBytes: 0,
        transportReady: false,
    });

    function logState() {
        log.debug('[Analytics] State', {
            status: state.value.status,
            transportReady: state.value.transportReady,
            queueDepth: state.value.queueDepth,
            pendingBytes: state.value.pendingBytes,
        });
    }

    async function load() {
        try {
            state.value = await native.analytics.getState();
            logState();
        } catch (error) {
            log.error('[Analytics] Failed to load analytics state:', error);
        }
    }

    async function toggle(nextEnabled: boolean) {
        try {
            state.value = await native.analytics.setEnabled(nextEnabled, state.value.consentEpoch);
            logState();
        } catch (error) {
            log.error('[Analytics] Failed to change analytics consent:', error);
            await load();
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
                data-testid="settings-analytics-share"
                control-width="auto"
                :label="t('settings.analytics.share')"
                :description="t('settings.analytics.shareDescription')"
            >
                <Switch
                    size="lg"
                    data-testid="settings-analytics-toggle"
                    :disabled="state.status === 'uninitialized' || !state.transportReady"
                    :model-value="state.status === 'enabled'"
                    @update:model-value="toggle"
                />
            </SettingsRow>
        </div>
    </section>
</template>
