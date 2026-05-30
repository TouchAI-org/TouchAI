<script setup lang="ts">
    import CustomSelect from '@components/CustomSelect.vue';
    import MarkdownContent from '@components/MarkdownContent.vue';
    import { appUpdateService } from '@services/AppUpdateService';
    import type { AppUpdateChannel, AppUpdateState } from '@services/AppUpdateService/types';
    import { getVersion } from '@tauri-apps/api/app';
    import { openUrl } from '@tauri-apps/plugin-opener';
    import { computed, onMounted, onUnmounted, ref } from 'vue';

    import { APP_UPDATE_CHANNELS, appUpdateChannelLabel } from '@/config/appUpdate';
    import { APP_PRODUCT_CONFIG } from '@/config/product';
    import { t } from '@/i18n';
    import { formatDateTime } from '@/i18n/format';
    import { preferredAppUpdateDownload } from '@/services/AppUpdateService/downloads';

    defineOptions({
        name: 'SettingsGeneralUpdateSection',
    });

    type ChannelOption = {
        value: AppUpdateChannel;
        label: string;
        description: string;
    };

    const updateState = ref<AppUpdateState>(appUpdateService.getState());
    const appVersion = ref('0.1.0');
    const detailsOpen = ref(false);
    let unsubscribeUpdateState: (() => void) | null = null;

    function channelDescriptionKey(channel: AppUpdateChannel) {
        return `settings.general.update.channel.${channel}.description` as const;
    }

    const channelOptions = computed<ChannelOption[]>(() =>
        APP_UPDATE_CHANNELS.map((value) => ({
            value,
            label: appUpdateChannelLabel(value),
            description: t(channelDescriptionKey(value)),
        }))
    );

    const visibleUpdate = computed(
        () => updateState.value.downloadedUpdate ?? updateState.value.availableUpdate
    );
    const latestUpdate = computed(() => updateState.value.latestUpdate);
    const targetVersion = computed(
        () =>
            visibleUpdate.value?.version ??
            latestUpdate.value?.version ??
            updateState.value.updateRequirement?.minimumSupportedVersion ??
            ''
    );
    const channelLabel = computed(() => appUpdateChannelLabel(updateState.value.channel));
    const releaseNotes = computed(
        () => visibleUpdate.value?.notes?.trim() || latestUpdate.value?.releaseNotes?.trim() || ''
    );
    const currentDisplayVersion = computed(
        () => updateState.value.currentVersion ?? appVersion.value
    );
    const latestDisplayVersion = computed(
        () => latestUpdate.value?.version ?? currentDisplayVersion.value
    );
    const directDownload = computed(() =>
        preferredAppUpdateDownload(latestUpdate.value?.downloads ?? [])
    );
    const updateDownloadUrl = computed(
        () =>
            directDownload.value?.url ??
            latestUpdate.value?.releaseUrl ??
            APP_PRODUCT_CONFIG.repository.releasesUrl
    );

    const isChecking = computed(() => updateState.value.status === 'checking');
    const isDownloading = computed(() => updateState.value.status === 'downloading');
    const isInstalling = computed(() => updateState.value.status === 'installing');
    const isBusy = computed(() => isChecking.value || isDownloading.value || isInstalling.value);
    const canInstall = computed(() => updateState.value.status === 'downloaded');
    const canUseInAppUpdate = computed(
        () =>
            updateState.value.status === 'available' &&
            (updateState.value.updateRequirement?.targetSatisfiesRequirement ?? true)
    );
    const canShowDetails = computed(() => Boolean(latestUpdate.value || visibleUpdate.value));

    const statusTitle = computed(() => {
        if (isChecking.value) {
            return t('settings.general.update.status.checking');
        }

        if (isDownloading.value) {
            return t('settings.general.update.status.downloading', {
                progress: updateState.value.downloadProgress ?? 0,
            });
        }

        if (isInstalling.value) {
            return t('settings.general.update.status.installing');
        }

        if (updateState.value.status === 'available' || updateState.value.status === 'downloaded') {
            return t('settings.general.update.status.availableVersion', {
                version: targetVersion.value || appVersion.value,
            });
        }

        if (updateState.value.status === 'not_available') {
            return t('settings.general.update.status.latestVersion', {
                version: latestDisplayVersion.value,
            });
        }

        if (updateState.value.status === 'failed') {
            return t('settings.general.update.status.failed');
        }

        if (updateState.value.status === 'unsupported') {
            return t('settings.general.update.status.unsupported');
        }

        return t('settings.general.update.status.unchecked');
    });

    const statusDescription = computed(() => {
        if (updateState.value.lastCheckedAt) {
            return t('settings.general.update.lastChecked', {
                time: formatDateTime(updateState.value.lastCheckedAt),
            });
        }

        return t('settings.general.update.notChecked');
    });

    const primaryDetailsActionText = computed(() => {
        if (isDownloading.value) {
            return t('settings.general.update.dialog.action.downloading', {
                progress: updateState.value.downloadProgress ?? 0,
            });
        }

        if (isInstalling.value) {
            return t('settings.general.update.dialog.action.installing');
        }

        if (canInstall.value) {
            return t('settings.update.action.installRestart');
        }

        if (canUseInAppUpdate.value) {
            return t('settings.general.update.dialog.action.download');
        }

        return t('settings.general.update.dialog.action.openDownload');
    });

    const hasUpdateDetails = computed(() => {
        if (
            ['available', 'downloaded', 'downloading', 'installing'].includes(
                updateState.value.status
            )
        ) {
            return true;
        }

        return (
            updateState.value.status === 'unsupported' &&
            Boolean(latestUpdate.value?.version) &&
            latestUpdate.value?.version !== currentDisplayVersion.value
        );
    });

    const detailsTitle = computed(() =>
        hasUpdateDetails.value && (latestUpdate.value?.version || visibleUpdate.value?.version)
            ? t('settings.general.update.dialog.availableTitle', {
                  version: latestUpdate.value?.version ?? visibleUpdate.value?.version ?? '',
                  channel: channelLabel.value,
              })
            : t('settings.general.update.status.latestVersion', {
                  version: latestDisplayVersion.value,
              })
    );

    const versionLine = computed(() =>
        t('settings.general.update.dialog.versionLine', {
            current: currentDisplayVersion.value,
            target: targetVersion.value || appVersion.value,
        })
    );

    async function initializeUpdates() {
        unsubscribeUpdateState = appUpdateService.subscribe((state) => {
            updateState.value = state;
        });

        try {
            const [version] = await Promise.all([getVersion(), appUpdateService.initialize()]);
            appVersion.value = version;
        } catch (error) {
            console.error('[SettingsGeneralUpdateSection] Failed to initialize updates:', error);
        }
    }

    async function checkForUpdates() {
        await appUpdateService.checkNow('manual');
    }

    async function selectUpdateChannel(channel: AppUpdateChannel) {
        if (channel === updateState.value.channel || isBusy.value) {
            return;
        }

        await appUpdateService.setChannel(channel);
    }

    async function toggleAutoCheck() {
        if (isBusy.value) {
            return;
        }

        await appUpdateService.setAutoCheckEnabled(!updateState.value.autoCheckEnabled);
    }

    async function runDetailsAction() {
        if (isBusy.value) {
            return;
        }

        if (canInstall.value) {
            await appUpdateService.install();
            return;
        }

        if (canUseInAppUpdate.value) {
            await appUpdateService.download();
            return;
        }

        await openUrl(updateDownloadUrl.value);
    }

    async function handlePrimaryAction() {
        if (canShowDetails.value) {
            detailsOpen.value = true;
            return;
        }

        await checkForUpdates();
    }

    onMounted(() => {
        void initializeUpdates();
    });

    onUnmounted(() => {
        unsubscribeUpdateState?.();
        unsubscribeUpdateState = null;
    });
</script>

<template>
    <section
        id="settings-update-section"
        class="space-y-4"
        data-settings-update-section="true"
        data-testid="settings-update-section"
    >
        <div>
            <h2 class="settings-section-title">
                {{ t('settings.general.update.channelTitle') }}
            </h2>
        </div>

        <div class="settings-row-group divide-y divide-neutral-200/70">
            <div
                class="grid min-w-0 gap-4 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_180px] sm:items-center"
            >
                <label
                    data-testid="settings-general-row-label"
                    class="block text-[13px] leading-6 font-normal text-neutral-900"
                >
                    {{ t('settings.general.update.channelRowLabel') }}
                </label>
                <div data-testid="settings-general-control" class="ml-auto w-[180px]">
                    <CustomSelect
                        :model-value="updateState.channel"
                        :options="channelOptions"
                        :disabled="isBusy"
                        @update:model-value="selectUpdateChannel"
                    />
                </div>
            </div>

            <div
                class="grid min-w-0 gap-4 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
            >
                <div
                    data-testid="settings-general-row-label"
                    class="text-[13px] leading-6 font-normal text-neutral-900"
                >
                    {{ t('settings.general.update.autoCheck') }}
                </div>
                <button
                    type="button"
                    :class="[
                        'relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                        updateState.autoCheckEnabled ? 'settings-toggle-enabled' : 'bg-neutral-200',
                    ]"
                    data-testid="settings-update-auto-check-toggle"
                    :aria-pressed="updateState.autoCheckEnabled"
                    :disabled="isBusy"
                    @click="toggleAutoCheck"
                >
                    <span
                        :class="[
                            'inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform',
                            updateState.autoCheckEnabled ? 'translate-x-[18px]' : 'translate-x-1',
                        ]"
                    />
                </button>
            </div>

            <div
                class="grid min-w-0 gap-4 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
            >
                <div class="min-w-0">
                    <div
                        data-testid="settings-update-status-title"
                        class="text-[13px] leading-6 font-normal text-neutral-900"
                    >
                        {{ statusTitle }}
                    </div>
                    <div class="mt-0.5 text-[12px] leading-5 text-neutral-500">
                        {{ statusDescription }}
                    </div>
                    <div
                        v-if="updateState.status === 'failed' && updateState.error"
                        class="mt-0.5 text-[12px] leading-5 text-red-600"
                    >
                        {{ updateState.error }}
                    </div>
                </div>

                <button
                    type="button"
                    class="ml-auto inline-flex h-9 min-w-[88px] items-center justify-center rounded-[10px] border border-transparent bg-[#f0f0ef] px-3 text-[12px] font-normal text-neutral-800 transition-colors hover:bg-[#ececea] disabled:cursor-not-allowed disabled:opacity-50"
                    data-testid="settings-update-primary-action"
                    :disabled="isBusy && !isDownloading && !isInstalling"
                    @click="handlePrimaryAction"
                >
                    {{
                        canShowDetails
                            ? t('settings.general.update.action.details')
                            : t('settings.general.update.action.check')
                    }}
                </button>
            </div>
        </div>

        <div
            v-if="detailsOpen"
            class="fixed inset-0 z-[999] flex items-center justify-center bg-neutral-950/35 px-6 py-8 backdrop-blur-sm"
            data-testid="settings-update-details-dialog"
            role="dialog"
            aria-modal="true"
        >
            <section class="w-full max-w-[520px] rounded-[12px] bg-white p-5 shadow-xl">
                <h3 class="text-[17px] leading-7 font-medium text-neutral-950">
                    {{ t('settings.general.update.dialog.title') }}
                </h3>

                <div class="mt-4 space-y-3 text-[13px] leading-6 text-neutral-700">
                    <p class="font-medium text-neutral-950">{{ detailsTitle }}</p>
                    <p>{{ versionLine }}</p>
                    <div>
                        <p class="mb-2 font-medium text-neutral-950">
                            {{ t('settings.update.releaseNotes') }}
                        </p>
                        <div
                            class="settings-scrollbar max-h-[260px] overflow-y-auto rounded-[10px] border border-neutral-200/70 bg-[#f7f7f5] px-3 py-2"
                        >
                            <MarkdownContent
                                v-if="releaseNotes"
                                class="settings-update-release-notes"
                                :content="releaseNotes"
                                :final="true"
                            />
                            <p v-else class="text-[12px] leading-5 text-neutral-500">
                                {{ t('settings.general.update.dialog.noReleaseNotes') }}
                            </p>
                        </div>
                    </div>
                </div>

                <div class="mt-5 flex justify-end gap-2">
                    <button
                        type="button"
                        class="inline-flex h-9 items-center justify-center rounded-[10px] border border-transparent bg-[#f0f0ef] px-4 text-[12px] font-normal text-neutral-800 transition-colors hover:bg-[#ececea]"
                        @click="detailsOpen = false"
                    >
                        {{ t('common.cancel') }}
                    </button>
                    <button
                        type="button"
                        class="bg-primary-600 hover:bg-primary-700 inline-flex h-9 items-center justify-center rounded-[10px] px-4 text-[12px] font-normal text-white transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                        data-testid="settings-update-dialog-primary"
                        :disabled="isBusy"
                        @click="runDetailsAction"
                    >
                        {{ primaryDetailsActionText }}
                    </button>
                </div>
            </section>
        </div>
    </section>
</template>

<style scoped>
    .settings-update-release-notes.touchai-markdown {
        --touchai-markdown-body-size: 13px;
        --touchai-markdown-body-leading: 1.72;
        --touchai-flow-paragraph-y: 0.64rem;
        --touchai-flow-list-y: 0.58rem;
        --touchai-flow-list-item-y: 0.24rem;
        --touchai-flow-heading-1-mt: 0.7rem;
        --touchai-flow-heading-1-mb: 0.44rem;
        --touchai-flow-heading-2-mt: 0.66rem;
        --touchai-flow-heading-2-mb: 0.4rem;
        --touchai-flow-heading-3-mt: 0.6rem;
        --touchai-flow-heading-3-mb: 0.34rem;
        --touchai-heading-1-size: 1.18em;
        --touchai-heading-2-size: 1.12em;
        --touchai-heading-3-size: 1.08em;
        font-size: 13px;
        line-height: 1.72;
        letter-spacing: 0;
    }
</style>
