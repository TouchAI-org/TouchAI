<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import { appUpdateService } from '@services/AppUpdateService';
    import { getAppUpdateRequirementReasonText } from '@services/AppUpdateService/requirementText';
    import type { AppUpdateState } from '@services/AppUpdateService/types';
    import { openUrl } from '@tauri-apps/plugin-opener';
    import { computed, onMounted, onUnmounted, ref } from 'vue';

    import { APP_PRODUCT_CONFIG } from '@/config/product';
    import { t } from '@/i18n';
    import { preferredAppUpdateDownload } from '@/services/AppUpdateService/downloads';

    defineOptions({
        name: 'AppUpdateRequiredGate',
    });

    const updateState = ref<AppUpdateState>(appUpdateService.getState());
    let unsubscribe: (() => void) | null = null;

    const visibleUpdate = computed(
        () => updateState.value.downloadedUpdate ?? updateState.value.availableUpdate
    );
    const latestUpdate = computed(() => updateState.value.latestUpdate);
    const requirement = computed(() => updateState.value.updateRequirement);
    const shouldBlock = computed(() => requirement.value?.required ?? false);
    const isChecking = computed(() => updateState.value.status === 'checking');
    const isDownloading = computed(() => updateState.value.status === 'downloading');
    const isInstalling = computed(() => updateState.value.status === 'installing');
    const isBusy = computed(() => isChecking.value || isDownloading.value || isInstalling.value);
    const canUseInAppUpdate = computed(
        () =>
            updateState.value.status === 'available' &&
            (requirement.value?.targetSatisfiesRequirement ?? false)
    );
    const canInstall = computed(() => updateState.value.status === 'downloaded');
    const releaseNotes = computed(
        () => visibleUpdate.value?.notes?.trim() || latestUpdate.value?.releaseNotes?.trim() || ''
    );
    const directDownload = computed(() =>
        preferredAppUpdateDownload(latestUpdate.value?.downloads ?? [])
    );
    const directDownloadUrl = computed(() => directDownload.value?.url ?? null);
    const releaseDownloadUrl = computed(
        () =>
            directDownloadUrl.value ??
            latestUpdate.value?.releaseUrl ??
            APP_PRODUCT_CONFIG.repository.releasesUrl
    );
    const targetVersionText = computed(() => {
        if (visibleUpdate.value?.version) {
            return t('settings.update.required.availableVersion', {
                version: visibleUpdate.value.version,
            });
        }

        if (latestUpdate.value?.version) {
            return t('settings.update.required.availableVersion', {
                version: latestUpdate.value.version,
            });
        }

        const minimumVersion = requirement.value?.minimumSupportedVersion;
        return minimumVersion
            ? t('appUpdate.requiredGate.minimumVersion', { version: minimumVersion })
            : t('appUpdate.requiredGate.supportedVersionRequired');
    });
    const continueAfterUpdateText = computed(() =>
        t('appUpdate.requiredGate.continueAfterUpdate', {
            target: targetVersionText.value,
            appName: APP_PRODUCT_CONFIG.displayName,
        })
    );
    const detailText = computed(() => {
        const parts = [
            getAppUpdateRequirementReasonText(requirement.value),
            requirement.value?.minimumSupportedVersion
                ? t('settings.update.required.minimumSupportedVersion', {
                      version: requirement.value.minimumSupportedVersion,
                  })
                : null,
            updateState.value.currentVersion
                ? t('appUpdate.requiredGate.currentVersion', {
                      version: updateState.value.currentVersion,
                  })
                : null,
        ].filter(Boolean);

        return parts.join(' · ');
    });
    const primaryActionText = computed(() => {
        if (isChecking.value) {
            return t('settings.update.action.checking');
        }

        if (isDownloading.value) {
            return t('settings.update.action.downloading', {
                progress: updateState.value.downloadProgress ?? 0,
            });
        }

        if (isInstalling.value) {
            return t('settings.update.action.installing');
        }

        if (canInstall.value) {
            return t('settings.update.action.installRestart');
        }

        if (canUseInAppUpdate.value) {
            return t('settings.update.action.download');
        }

        return directDownloadUrl.value
            ? t('settings.update.action.downloadInstaller')
            : t('settings.update.action.downloadPage');
    });
    const errorDetailText = computed(() => {
        const error = updateState.value.error?.trim();
        return error ? t('settings.update.errorDetail', { error }) : '';
    });

    onMounted(async () => {
        unsubscribe = appUpdateService.subscribe((state) => {
            updateState.value = state;
        });

        try {
            await appUpdateService.initialize();
        } catch (error) {
            console.error('Failed to initialize update gate:', error);
        }
    });

    onUnmounted(() => {
        unsubscribe?.();
        unsubscribe = null;
    });

    async function runPrimaryAction() {
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

        await openUrl(releaseDownloadUrl.value);
    }

    async function checkAgain() {
        if (isBusy.value) {
            return;
        }

        await appUpdateService.checkNow('manual');
    }
</script>

<template>
    <div
        v-if="shouldBlock"
        class="fixed inset-0 z-[9999] flex items-center justify-center bg-gray-950/75 px-4 py-6 backdrop-blur-sm"
        data-testid="app-update-required-gate"
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-update-required-title"
    >
        <section class="w-full max-w-xl rounded-lg bg-white p-6 shadow-xl">
            <div class="flex items-start gap-4">
                <div
                    class="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-red-50 text-red-600"
                >
                    <AppIcon name="exclamation-triangle" class="h-6 w-6" />
                </div>

                <div class="min-w-0 flex-1">
                    <h1
                        id="app-update-required-title"
                        class="font-serif text-xl font-semibold text-gray-950"
                    >
                        {{ t('settings.update.required.unsupported') }}
                    </h1>
                    <p class="mt-2 font-serif text-sm leading-6 text-gray-600">
                        {{ continueAfterUpdateText }}
                    </p>
                </div>
            </div>

            <div class="mt-5 space-y-3">
                <div
                    v-if="detailText"
                    class="rounded-lg border border-red-100 bg-red-50 px-4 py-3 font-serif text-sm text-red-700"
                >
                    {{ detailText }}
                </div>

                <div
                    v-if="isDownloading"
                    class="h-2 overflow-hidden rounded-full bg-gray-100"
                    :aria-label="t('settings.update.downloadProgress')"
                >
                    <div
                        class="bg-primary-600 h-full rounded-full transition-all"
                        :style="{ width: `${updateState.downloadProgress ?? 0}%` }"
                    />
                </div>

                <div
                    v-if="releaseNotes"
                    class="max-h-44 overflow-auto rounded-lg border border-gray-200 bg-gray-50 p-4"
                >
                    <div class="mb-2 font-serif text-sm font-medium text-gray-900">
                        {{ t('settings.update.releaseNotes') }}
                    </div>
                    <pre class="font-serif text-xs leading-5 whitespace-pre-wrap text-gray-600">{{
                        releaseNotes
                    }}</pre>
                </div>

                <div
                    v-if="errorDetailText"
                    class="rounded-lg border border-red-100 bg-red-50 px-4 py-3 font-serif text-sm text-red-700"
                >
                    {{ errorDetailText }}
                </div>
            </div>

            <div class="mt-6 flex flex-wrap justify-end gap-2">
                <button
                    class="hover:border-primary-300 hover:text-primary-700 inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2 font-serif text-sm text-gray-700 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                    :disabled="isBusy"
                    data-testid="app-update-required-check"
                    @click="checkAgain"
                >
                    <AppIcon name="refresh" class="h-4 w-4" />
                    {{ t('settings.update.action.recheck') }}
                </button>
                <button
                    class="bg-primary-600 hover:bg-primary-700 inline-flex items-center gap-2 rounded-lg px-4 py-2 font-serif text-sm text-white transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                    :disabled="isBusy"
                    data-testid="app-update-required-primary"
                    @click="runPrimaryAction"
                >
                    <AppIcon
                        :name="
                            canInstall
                                ? 'check-circle'
                                : canUseInAppUpdate
                                  ? 'arrow-down'
                                  : directDownloadUrl
                                    ? 'arrow-down'
                                    : 'folder-open'
                        "
                        class="h-4 w-4"
                    />
                    {{ primaryActionText }}
                </button>
            </div>
        </section>
    </div>
</template>
