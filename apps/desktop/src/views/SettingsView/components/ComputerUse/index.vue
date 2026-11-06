<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import SettingsRow from '@components/SettingsRow.vue';
    import { Button } from '@components/ui/button';
    import { Input } from '@components/ui/input';
    import { Switch } from '@components/ui/switch';
    import { useConfirm } from '@composables/useConfirm';
    import {
        computerUseService,
        type ComputerUseSettings,
        type ComputerUseStats,
        type ComputerUseStatus,
        type ComputerUseUpdate,
        DEFAULT_SETTINGS,
    } from '@services/ComputerUseService';
    import { computed, onMounted, ref } from 'vue';

    import { t } from '@/i18n';

    defineOptions({ name: 'ComputerUseSettings' });

    const settings = ref<ComputerUseSettings>({ ...DEFAULT_SETTINGS });
    const stats = ref<ComputerUseStats | null>(null);
    const status = ref<ComputerUseStatus | null>(null);
    const busy = ref(false);
    const feedback = ref<string | null>(null);
    const updateInfo = ref<ComputerUseUpdate | null>(null);
    const { confirm } = useConfirm();

    const installed = computed(() => status.value?.installed === true);

    const successRate = computed(() => {
        const value = stats.value;
        if (!value || value.actions === 0) return '—';
        return `${Math.round((value.successes / value.actions) * 100)}%`;
    });

    const statusLabel = computed(() => {
        if (!status.value) return t('settings.computerUse.status.loading');
        return installed.value
            ? t('settings.computerUse.status.installed')
            : t('settings.computerUse.status.missing');
    });

    async function refresh(): Promise<void> {
        status.value = await computerUseService.status();
        stats.value = await computerUseService.loadStats();
    }

    onMounted(async () => {
        settings.value = await computerUseService.loadSettings();
        await refresh();
    });

    async function prepare(): Promise<void> {
        busy.value = true;
        feedback.value = null;
        try {
            const next = await computerUseService.prepare();
            status.value = next;
            if (next.installed) {
                await computerUseService.applySettings(settings.value);
                if (settings.value.recordingEnabled) {
                    await computerUseService.setRecording(true);
                }
            }
            feedback.value = next.installed
                ? t('settings.computerUse.status.installed')
                : (next.error ?? t('settings.computerUse.status.missing'));
        } catch (error) {
            feedback.value = error instanceof Error ? error.message : String(error);
        } finally {
            busy.value = false;
        }
    }

    async function update(patch: Partial<ComputerUseSettings>): Promise<void> {
        settings.value = await computerUseService.saveSettings(patch);
        if (patch.approval === 'each') {
            computerUseService.clearSessionApprovals();
        }
        if ('maxImageDimension' in patch || 'cursorVisible' in patch) {
            const failures = await computerUseService.applySettings(settings.value);
            if (failures.length > 0) {
                feedback.value = failures[0] ?? null;
            }
        }
        if ('recordingEnabled' in patch) {
            await computerUseService.setRecording(settings.value.recordingEnabled);
        }
    }

    const updateLabel = computed(() => {
        const info = updateInfo.value;
        if (!info) return '—';
        if (info.error) return t('settings.computerUse.update.failed');
        if (info.updateAvailable && info.latest) {
            return t('settings.computerUse.update.available', { version: info.latest });
        }
        return t('settings.computerUse.update.current');
    });

    async function checkUpdate(): Promise<void> {
        busy.value = true;
        try {
            updateInfo.value = await computerUseService.checkUpdate();
        } finally {
            busy.value = false;
        }
    }

    async function removeDriver(): Promise<void> {
        const agreed = await confirm({
            message: t('settings.computerUse.confirm.remove'),
            title: t('settings.computerUse.action.remove'),
            type: 'danger',
        });
        if (!agreed) return;

        busy.value = true;
        try {
            await computerUseService.remove();
            await refresh();
            feedback.value = t('settings.computerUse.removed');
        } catch (error) {
            feedback.value = error instanceof Error ? error.message : String(error);
        } finally {
            busy.value = false;
        }
    }

    function setApproval(approval: ComputerUseSettings['approval']): void {
        void update({ approval });
    }

    function setMaxImageDimension(event: Event): void {
        const value = Number((event.target as HTMLInputElement).value);
        if (!Number.isFinite(value) || value <= 0) return;
        void update({ maxImageDimension: value });
    }
</script>

<template>
    <div class="space-y-6 px-6 py-6" data-testid="settings-computer-use">
        <section class="space-y-4">
            <h2 class="settings-section-title">{{ t('settings.computerUse.group.driver') }}</h2>

            <div class="settings-row-group divide-y divide-border-subtle">
                <SettingsRow
                    control-width="auto"
                    :label="t('settings.computerUse.field.status')"
                    :description="feedback ?? status?.error ?? undefined"
                >
                    <div class="ml-auto flex items-center gap-3">
                        <span class="text-xs text-text-tertiary">{{ statusLabel }}</span>
                        <Button size="sm" variant="outline" :disabled="busy" @click="refresh">
                            {{ t('settings.computerUse.action.refresh') }}
                        </Button>
                        <Button size="sm" :disabled="busy" @click="prepare">
                            {{ t('settings.computerUse.action.prepare') }}
                        </Button>
                    </div>
                </SettingsRow>

                <SettingsRow control-width="360" :label="t('settings.computerUse.field.version')">
                    <span class="text-xs text-text-tertiary">
                        {{ status?.driverVersion ?? '—' }}
                    </span>
                </SettingsRow>

                <SettingsRow control-width="360" :label="t('settings.computerUse.field.abi')">
                    <span class="text-xs text-text-tertiary">
                        {{ status?.abiVersion ?? '—' }}
                    </span>
                </SettingsRow>

                <SettingsRow control-width="360" :label="t('settings.computerUse.field.path')">
                    <span class="truncate text-xs text-text-tertiary">
                        {{ status?.binary ?? '—' }}
                    </span>
                </SettingsRow>

                <SettingsRow control-width="auto" :label="t('settings.computerUse.field.update')">
                    <div class="ml-auto flex items-center gap-3">
                        <span class="text-xs text-text-tertiary">{{ updateLabel }}</span>
                        <Button size="sm" variant="outline" :disabled="busy" @click="checkUpdate">
                            {{ t('settings.computerUse.action.checkUpdate') }}
                        </Button>
                        <Button size="sm" variant="outline" :disabled="busy" @click="removeDriver">
                            {{ t('settings.computerUse.action.remove') }}
                        </Button>
                    </div>
                </SettingsRow>
            </div>
        </section>

        <section class="space-y-4">
            <h2 class="settings-section-title">{{ t('settings.computerUse.group.behavior') }}</h2>

            <div class="settings-row-group divide-y divide-border-subtle">
                <SettingsRow control-width="auto" :label="t('settings.computerUse.field.cursor')">
                    <div class="ml-auto">
                        <Switch
                            :model-value="settings.cursorVisible"
                            @update:model-value="
                                (value: boolean) => update({ cursorVisible: value })
                            "
                        />
                    </div>
                </SettingsRow>

                <SettingsRow
                    control-width="180"
                    :label="t('settings.computerUse.field.maxImage')"
                    :description="t('settings.computerUse.hint.maxImage')"
                >
                    <Input
                        type="number"
                        min="320"
                        max="4096"
                        :model-value="settings.maxImageDimension"
                        @change="setMaxImageDimension"
                    />
                </SettingsRow>
            </div>
        </section>

        <section class="space-y-4">
            <h2 class="settings-section-title">{{ t('settings.computerUse.group.permission') }}</h2>

            <div class="settings-row-group divide-y divide-border-subtle">
                <SettingsRow control-width="auto" :label="t('settings.computerUse.field.approval')">
                    <div class="ml-auto flex items-center gap-2">
                        <Button
                            size="sm"
                            :variant="settings.approval === 'each' ? 'default' : 'outline'"
                            @click="setApproval('each')"
                        >
                            {{ t('settings.computerUse.approval.each') }}
                        </Button>
                        <Button
                            size="sm"
                            :variant="
                                settings.approval === 'session-window' ? 'default' : 'outline'
                            "
                            @click="setApproval('session-window')"
                        >
                            {{ t('settings.computerUse.approval.session') }}
                        </Button>
                    </div>
                </SettingsRow>

                <SettingsRow
                    control-width="auto"
                    :label="t('settings.computerUse.field.foreground')"
                    :description="t('settings.computerUse.hint.foreground')"
                >
                    <div class="ml-auto">
                        <Switch
                            :model-value="settings.allowForeground"
                            @update:model-value="
                                (value: boolean) => update({ allowForeground: value })
                            "
                        />
                    </div>
                </SettingsRow>
            </div>
        </section>

        <section class="space-y-4">
            <h2 class="settings-section-title">{{ t('settings.computerUse.group.privacy') }}</h2>

            <div class="settings-row-group divide-y divide-border-subtle">
                <SettingsRow
                    control-width="auto"
                    :label="t('settings.computerUse.field.telemetry')"
                    :description="t('settings.computerUse.hint.telemetry')"
                >
                    <span class="ml-auto text-xs text-text-tertiary">
                        {{ t('settings.computerUse.telemetry.driver') }}
                    </span>
                </SettingsRow>

                <SettingsRow
                    control-width="auto"
                    :label="t('settings.computerUse.field.recording')"
                    :description="t('settings.computerUse.hint.recording')"
                >
                    <div class="ml-auto">
                        <Switch
                            :model-value="settings.recordingEnabled"
                            @update:model-value="
                                (value: boolean) => update({ recordingEnabled: value })
                            "
                        />
                    </div>
                </SettingsRow>
            </div>
        </section>

        <section class="space-y-4">
            <h2 class="settings-section-title">{{ t('settings.computerUse.group.stats') }}</h2>

            <div class="settings-row-group divide-y divide-border-subtle">
                <SettingsRow control-width="320" :label="t('settings.computerUse.stats.actions')">
                    <span class="text-xs text-text-tertiary">{{ stats?.actions ?? 0 }}</span>
                </SettingsRow>

                <SettingsRow control-width="320" :label="t('settings.computerUse.stats.success')">
                    <span class="text-xs text-text-tertiary">{{ successRate }}</span>
                </SettingsRow>

                <SettingsRow control-width="320" :label="t('settings.computerUse.stats.denied')">
                    <span class="text-xs text-text-tertiary">{{ stats?.denied ?? 0 }}</span>
                </SettingsRow>

                <SettingsRow
                    control-width="320"
                    :label="t('settings.computerUse.stats.avgDuration')"
                >
                    <span class="text-xs text-text-tertiary">
                        {{ stats?.avgDurationMs ? `${stats.avgDurationMs} ms` : '—' }}
                    </span>
                </SettingsRow>
            </div>
        </section>
    </div>
</template>
