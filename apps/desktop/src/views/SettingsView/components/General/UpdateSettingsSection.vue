<script setup lang="ts">
    import CustomSelect from '@components/CustomSelect.vue';
    import { appUpdateService } from '@services/AppUpdateService';
    import { getAvailableAppUpdateVersion } from '@services/AppUpdateService/availability';
    import type { AppUpdateChannel } from '@services/AppUpdateService/types';
    import { getVersion } from '@tauri-apps/api/app';
    import { openUrl } from '@tauri-apps/plugin-opener';
    import { computed, onMounted, ref } from 'vue';

    import { useAppUpdateState } from '@/composables/useAppUpdateState';
    import { APP_UPDATE_CHANNELS, appUpdateChannelLabel } from '@/config/appUpdate';
    import { APP_PRODUCT_CONFIG, APP_VERSION } from '@/config/product';
    import { t } from '@/i18n';
    import { formatDateTime } from '@/i18n/format';
    import { preferredAppUpdateDownload } from '@/services/AppUpdateService/downloads';

    import UpdateDetailsDialog from './UpdateDetailsDialog.vue';

    defineOptions({
        name: 'SettingsGeneralUpdateSection',
    });

    type ChannelOption = {
        value: AppUpdateChannel;
        label: string;
        description: string;
    };

    const updateState = useAppUpdateState();
    const appVersion = ref(APP_VERSION);
    const detailsOpen = ref(false);

    function channelDescriptionKey(channel: AppUpdateChannel) {
        return `settings.general.update.channel.${channel}.description` as const;
    }

    function channelLabelKey(channel: AppUpdateChannel) {
        return `settings.general.update.channel.${channel}.label` as const;
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
    const channelLabel = computed(() => t(channelLabelKey(updateState.value.channel)));
    const releaseNotes = computed(
        () => visibleUpdate.value?.notes?.trim() || latestUpdate.value?.releaseNotes?.trim() || ''
    );
    const currentDisplayVersion = computed(
        () => updateState.value.currentVersion ?? appVersion.value
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
                version: currentDisplayVersion.value,
            });
        }

        if (updateState.value.status === 'failed') {
            return t('settings.general.update.status.failed');
        }

        if (updateState.value.status === 'unsupported') {
            return t('settings.general.update.status.unsupported');
        }

        return t('settings.general.update.status.currentVersion', {
            version: currentDisplayVersion.value,
        });
    });

    const statusDescription = computed(() => {
        if (updateState.value.lastCheckedAt) {
            return t('settings.general.update.lastChecked', {
                time: formatDateTime(updateState.value.lastCheckedAt),
            });
        }

        return '';
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

    const hasUpdateDetails = computed(() =>
        Boolean(getAvailableAppUpdateVersion(updateState.value, currentDisplayVersion.value))
    );

    const detailsTitle = computed(() =>
        hasUpdateDetails.value
            ? t('settings.general.update.dialog.newVersionTitle')
            : t('settings.general.update.dialog.noVersion')
    );

    const dialogVersion = computed(() =>
        hasUpdateDetails.value
            ? targetVersion.value || currentDisplayVersion.value
            : currentDisplayVersion.value
    );
    const dialogPublishedAt = computed(() => {
        if (hasUpdateDetails.value) {
            return latestUpdate.value?.publishedAt ?? null;
        }

        return latestUpdate.value?.version === currentDisplayVersion.value
            ? latestUpdate.value.publishedAt
            : updateState.value.lastCheckedAt;
    });

    async function initializeUpdates() {
        try {
            appVersion.value = await getVersion();
        } catch (error) {
            console.error('[SettingsGeneralUpdateSection] Failed to initialize updates:', error);
        }
    }

    async function checkForUpdates(source: 'manual' | 'settings-open' = 'manual') {
        return appUpdateService.checkNow(source);
    }

    async function checkAndOpenUpdates(source: 'manual' | 'settings-open' = 'manual') {
        const completed = await checkForUpdates(source);
        const updateCanBeShown =
            completed ||
            ['available', 'downloaded', 'unsupported'].includes(updateState.value.status);
        if (updateCanBeShown && hasUpdateDetails.value) {
            detailsOpen.value = true;
        }
    }

    async function selectUpdateChannel(channel: AppUpdateChannel) {
        if (channel === updateState.value.channel || isBusy.value) {
            return;
        }

        await appUpdateService.setChannel(channel);
        await checkForUpdates('settings-open');
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
        await checkAndOpenUpdates();
    }

    defineExpose({ checkAndOpenUpdates });

    onMounted(() => {
        void initializeUpdates();
    });
</script>

<template>
    <section
        id="settings-update-section"
        class="space-y-4"
        data-settings-search-target="updates"
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
                data-settings-search-target="update-channel"
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
                data-settings-search-target="update-auto-check"
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
                        't-toggle-track relative inline-flex h-5 w-9 items-center rounded-full disabled:cursor-not-allowed disabled:opacity-50',
                        updateState.autoCheckEnabled ? 'settings-toggle-enabled' : 'bg-neutral-200',
                    ]"
                    data-testid="settings-update-auto-check-toggle"
                    :aria-pressed="updateState.autoCheckEnabled"
                    :disabled="isBusy"
                    @click="toggleAutoCheck"
                >
                    <span
                        :class="[
                            't-toggle-thumb inline-block h-3.5 w-3.5 transform rounded-full bg-white',
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
                    <div
                        v-if="statusDescription"
                        class="mt-0.5 text-[12px] leading-5 text-neutral-500"
                    >
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
                    :disabled="isBusy"
                    @click="handlePrimaryAction"
                >
                    {{ t('settings.general.update.action.check') }}
                </button>
            </div>
        </div>

        <UpdateDetailsDialog
            v-if="detailsOpen"
            :title="detailsTitle"
            :version="dialogVersion"
            :channel="channelLabel"
            :published-at="dialogPublishedAt"
            :has-update="hasUpdateDetails"
            :release-notes="hasUpdateDetails ? releaseNotes : ''"
            :action-text="primaryDetailsActionText"
            :busy="isBusy"
            :download-progress="isDownloading ? (updateState.downloadProgress ?? 0) : null"
            :error="updateState.error"
            @close="detailsOpen = false"
            @action="runDetailsAction"
        />
    </section>
</template>
