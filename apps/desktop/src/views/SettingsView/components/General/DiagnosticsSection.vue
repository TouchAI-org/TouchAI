<script setup lang="ts">
    import SettingsRow from '@components/SettingsRow.vue';
    import { Button } from '@components/ui/button';
    import { Switch } from '@components/ui/switch';
    import { useAlert } from '@composables/useAlert';
    import { useConfirm } from '@composables/useConfirm';
    import { native } from '@services/NativeService';
    import type { DiagnosticBundlePreview } from '@services/NativeService/types';
    import { log } from '@services/ObservabilityService';
    import { save } from '@tauri-apps/plugin-dialog';
    import { computed, onMounted, onUnmounted, ref } from 'vue';

    import { t } from '@/i18n';

    defineOptions({
        name: 'SettingsDiagnosticsSection',
    });

    const alert = useAlert();
    const { confirm } = useConfirm();
    const enabled = ref(false);
    const expiresAtMs = ref(0);
    const nowMs = ref(Date.now());
    const preview = ref<DiagnosticBundlePreview | null>(null);
    const exporting = ref(false);
    let timer: ReturnType<typeof setInterval> | null = null;

    const crashCount = computed(
        () => preview.value?.files.filter((file) => file.name.startsWith('crashes/')).length ?? 0
    );
    const remaining = computed(() => {
        const seconds = Math.max(0, Math.ceil((expiresAtMs.value - nowMs.value) / 1000));
        const minutes = Math.floor(seconds / 60);
        return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
    });

    async function refreshPreview() {
        preview.value = await native.observability.previewBundle();
    }

    async function loadStatus() {
        try {
            const status = await native.observability.diagnosticModeStatus();
            enabled.value = status.enabled;
            expiresAtMs.value = status.expiresAtMs;
            await refreshPreview();
        } catch (error) {
            log.error('[Diagnostics] Failed to load diagnostics status:', error);
        }
    }

    async function toggleDiagnosticMode(nextEnabled: boolean) {
        enabled.value = nextEnabled;
        try {
            const status = await native.observability.setDiagnosticMode(nextEnabled);
            enabled.value = status.enabled;
            expiresAtMs.value = status.expiresAtMs;
            nowMs.value = Date.now();
        } catch (error) {
            enabled.value = !nextEnabled;
            log.error('[Diagnostics] Failed to change diagnostic mode:', error);
            alert.error(t('settings.diagnostics.modeFailed'));
        }
    }

    async function exportDiagnostics() {
        exporting.value = true;
        try {
            const current = await native.observability.previewBundle();
            preview.value = current;
            const confirmed = await confirm({
                title: t('settings.diagnostics.exportTitle'),
                message: t('settings.diagnostics.exportConfirm', {
                    count: current.files.length,
                    size: Math.ceil(current.totalBytes / 1024),
                }),
                type: 'info',
            });
            if (!confirmed) return;

            const timestamp = new Date().toISOString().replace(/:/g, '-').slice(0, 19);
            const destination = await save({
                defaultPath: `TouchAI-diagnostics-${timestamp}.zip`,
                filters: [
                    {
                        name: t('settings.diagnostics.dialogFilter'),
                        extensions: ['zip'],
                    },
                ],
            });
            if (!destination) return;
            await native.observability.exportBundle(destination);
            alert.success(t('settings.diagnostics.exportSuccess'));
        } catch (error) {
            log.error('[Diagnostics] Failed to export bundle:', error);
            alert.error(t('settings.diagnostics.exportFailed'));
        } finally {
            exporting.value = false;
        }
    }

    async function dismissCrashes() {
        try {
            await native.observability.dismissCrashes();
            await refreshPreview();
        } catch (error) {
            log.error('[Diagnostics] Failed to dismiss crash records:', error);
        }
    }

    onMounted(async () => {
        await loadStatus();
        timer = setInterval(() => {
            nowMs.value = Date.now();
            if (expiresAtMs.value > 0 && nowMs.value >= expiresAtMs.value) {
                enabled.value = false;
                expiresAtMs.value = 0;
            }
        }, 1000);
    });

    onUnmounted(() => {
        if (timer) clearInterval(timer);
    });
</script>

<template>
    <section class="space-y-4" data-settings-search-target="diagnostics">
        <h2 class="settings-section-title">{{ t('settings.diagnostics.title') }}</h2>
        <p v-if="preview?.logDirectoryFallback" class="settings-section-description">
            {{ t('settings.diagnostics.logFallback') }}
        </p>

        <div class="settings-row-group divide-y divide-border-subtle">
            <SettingsRow
                data-settings-search-target="diagnostic-mode"
                control-width="auto"
                :label="t('settings.diagnostics.diagnosticMode')"
            >
                <div class="ml-auto flex items-center gap-3">
                    <span v-if="enabled" class="text-xs text-text-tertiary">
                        {{
                            t('settings.diagnostics.remaining', {
                                time: remaining,
                            })
                        }}
                    </span>
                    <Switch
                        size="lg"
                        :model-value="enabled"
                        @update:model-value="toggleDiagnosticMode"
                    />
                </div>
            </SettingsRow>

            <SettingsRow
                data-settings-search-target="diagnostic-export"
                control-width="auto"
                :label="t('settings.diagnostics.exportBundle')"
            >
                <Button
                    variant="outline-neutral"
                    class="ml-auto"
                    :disabled="exporting"
                    @click="exportDiagnostics"
                >
                    {{
                        exporting
                            ? t('settings.diagnostics.exporting')
                            : t('settings.diagnostics.exportBundle')
                    }}
                </Button>
            </SettingsRow>

            <SettingsRow
                v-if="crashCount > 0"
                data-settings-search-target="diagnostic-crashes"
                control-width="auto"
                :label="t('settings.diagnostics.crashRecords')"
            >
                <div class="ml-auto flex items-center gap-3">
                    <span class="text-xs text-text-tertiary">
                        {{ t('settings.diagnostics.crashRecordsCount', { count: crashCount }) }}
                    </span>
                    <Button variant="outline-neutral" @click="dismissCrashes">
                        {{ t('settings.diagnostics.dismissCrashes') }}
                    </Button>
                </div>
            </SettingsRow>
        </div>
    </section>
</template>
