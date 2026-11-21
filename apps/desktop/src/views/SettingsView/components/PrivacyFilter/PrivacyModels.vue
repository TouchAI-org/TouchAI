<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import CustomSelect from '@components/CustomSelect.vue';
    import SettingsRow from '@components/SettingsRow.vue';
    import { Badge } from '@components/ui/badge';
    import { Button } from '@components/ui/button';
    import { Input } from '@components/ui/input';
    import { useAlert } from '@composables/useAlert';
    import { useConfirm } from '@composables/useConfirm';
    import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

    import { log } from '@/app/api/diagnostics';
    import {
        DEFAULT_PRIVACY_MODEL_ID,
        type PrivacyDataType,
        type PrivacyFilterModelId,
        type PrivacyFilterModelInfo,
        type PrivacyFilterModelStatus,
        usePrivacyApi,
    } from '@/app/api/privacy';
    import { t } from '@/i18n';
    import { usePrivacyStore } from '@/stores/privacy';

    const props = defineProps<{
        disabled: boolean;
        confidenceThreshold: number;
        activationRequested?: boolean;
    }>();
    const emit = defineEmits<{
        'update:confidenceThreshold': [value: number];
        'update:modelDataTypes': [value: PrivacyDataType[]];
        modelReady: [modelId: PrivacyFilterModelId];
        cancelActivation: [];
    }>();
    const privacyApi = usePrivacyApi();
    const settingsStore = usePrivacyStore();
    const alert = useAlert();
    const { confirm } = useConfirm();
    const models = ref<PrivacyFilterModelInfo[]>([]);
    const statuses = ref<Partial<Record<PrivacyFilterModelId, PrivacyFilterModelStatus>>>({});
    const statusFailed = ref(false);
    const refreshing = ref(false);
    const menuOpen = ref(false);
    const busyModel = ref<PrivacyFilterModelId | null>(null);
    const cancellingModel = ref<PrivacyFilterModelId | null>(null);
    const modelSection = ref<HTMLElement | null>(null);
    let unlisten: (() => void) | undefined;
    let disposed = false;
    let refreshSequence = 0;

    const selectedId = computed(() => settingsStore.privacyFilterModelId);
    const selectedModel = computed(() =>
        models.value.find((model) => model.id === selectedId.value)
    );
    const installed = computed(() => Boolean(statuses.value[selectedId.value]?.installed));
    const downloading = computed(() =>
        models.value.find((model) => statuses.value[model.id]?.downloading)
    );
    const controlsDisabled = computed(() => props.disabled && !props.activationRequested);
    const selectorDisabled = computed(
        () =>
            controlsDisabled.value ||
            (!statuses.value[selectedId.value] && !statusFailed.value && !models.value.length)
    );
    const options = computed(() =>
        models.value.map((model) => ({
            value: model.id,
            label: model.name,
            description: formatBytes(model.totalBytes),
            disabled:
                !model.supported ||
                !statuses.value[model.id]?.installed ||
                Boolean(busyModel.value),
        }))
    );
    function formatBytes(bytes: number): string {
        const divisor = bytes >= 1_000_000_000 ? 1_000_000_000 : 1_000_000;
        return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(bytes / divisor)} ${divisor === 1_000_000_000 ? 'GB' : 'MB'}`;
    }

    async function refresh(readyModelId: PrivacyFilterModelId = DEFAULT_PRIVACY_MODEL_ID) {
        const sequence = ++refreshSequence;
        refreshing.value = true;
        statusFailed.value = false;
        try {
            const catalog = models.value.length ? models.value : await privacyApi.getModels();
            if (disposed || sequence !== refreshSequence) return;
            models.value = catalog;
            const results = await Promise.allSettled(
                catalog.map((model) => privacyApi.getModelStatus(model.id))
            );
            if (disposed || sequence !== refreshSequence) return;
            results.forEach((result, index) => {
                if (result.status === 'fulfilled') {
                    statuses.value[catalog[index]!.id] = result.value;
                }
            });
            statusFailed.value = results.some((result) => result.status === 'rejected');
            const ready = results[catalog.findIndex((model) => model.id === readyModelId)];
            if (
                props.activationRequested &&
                ready?.status === 'fulfilled' &&
                ready.value.installed &&
                !ready.value.downloading
            )
                emit('modelReady', readyModelId);
        } catch {
            if (!disposed && sequence === refreshSequence) statusFailed.value = true;
            log.warn('[PrivacyProtection] Could not read model status');
        } finally {
            if (sequence === refreshSequence) refreshing.value = false;
        }
    }

    async function requestDownload() {
        await refresh();
        await nextTick();
        if (disposed || controlsDisabled.value) return;
        modelSection.value?.scrollIntoView({ block: 'center', behavior: 'instant' });
        menuOpen.value = true;
    }
    defineExpose({ requestDownload });

    async function selectModel(modelId: PrivacyFilterModelId) {
        if (
            controlsDisabled.value ||
            !statuses.value[modelId]?.installed ||
            busyModel.value ||
            downloading.value
        )
            return;
        if (props.activationRequested) {
            emit('modelReady', modelId);
            return;
        }
        try {
            await settingsStore.updatePrivacyFilterModelId(modelId);
            await privacyApi.releaseModels();
        } catch {
            alert.error(t('settings.privacyFilter.saveFailed'));
        }
    }

    async function downloadModel(modelId: PrivacyFilterModelId) {
        const model = models.value.find((item) => item.id === modelId);
        const status = statuses.value[modelId];
        if (
            controlsDisabled.value ||
            !model?.supported ||
            !status ||
            statusFailed.value ||
            status.installed ||
            downloading.value ||
            busyModel.value
        )
            return;
        const previouslySelected = selectedId.value;
        const preparingActivation = props.activationRequested;
        busyModel.value = modelId;
        cancellingModel.value = null;
        statuses.value[modelId] = { ...status, downloading: true, downloadedBytes: 0 };
        try {
            await privacyApi.downloadModel(modelId, 'auto');
            await refresh(modelId);
            if (preparingActivation) return;
            if (
                !disposed &&
                !controlsDisabled.value &&
                selectedId.value === previouslySelected &&
                statuses.value[modelId]?.installed
            ) {
                await settingsStore.updatePrivacyFilterModelId(modelId);
                await privacyApi.releaseModels();
            }
        } catch {
            if (!disposed && cancellingModel.value !== modelId)
                alert.error(t('settings.privacyFilter.modelDownloadFailed'));
            await refresh();
        } finally {
            busyModel.value = null;
            cancellingModel.value = null;
        }
    }

    async function cancelDownload(modelId: PrivacyFilterModelId) {
        if (
            controlsDisabled.value ||
            !statuses.value[modelId]?.downloading ||
            cancellingModel.value
        )
            return;
        cancellingModel.value = modelId;
        if (props.activationRequested) emit('cancelActivation');
        try {
            await privacyApi.cancelModelDownload(modelId);
        } catch {
            cancellingModel.value = null;
            if (!disposed) alert.error(t('settings.privacyFilter.modelCancelFailed'));
        }
    }

    async function deleteModel(modelId: PrivacyFilterModelId) {
        const model = models.value.find((item) => item.id === modelId);
        if (
            controlsDisabled.value ||
            !model ||
            !statuses.value[modelId]?.installed ||
            downloading.value ||
            busyModel.value
        )
            return;
        menuOpen.value = false;
        await nextTick();
        const approved = await confirm({
            title: t('settings.privacyFilter.modelDeleteTitle'),
            message: t('settings.privacyFilter.modelDeleteConfirm', {
                model: model.name,
                size: formatBytes(model.totalBytes),
            }),
            confirmText: t('settings.privacyFilter.modelDelete'),
            type: 'danger',
        });
        if (!approved || controlsDisabled.value || disposed || downloading.value || busyModel.value)
            return;
        busyModel.value = modelId;
        try {
            await privacyApi.deleteModel(modelId);
            await refresh();
        } catch {
            if (!disposed) alert.error(t('settings.privacyFilter.modelDeleteFailed'));
        } finally {
            busyModel.value = null;
        }
    }

    function setConfidence(value: string | number) {
        const number = Number(value);
        if (props.disabled || !installed.value || value === '' || !Number.isFinite(number)) return;
        emit('update:confidenceThreshold', Math.min(1, Math.max(0, number)));
    }

    watch(controlsDisabled, (disabled) => {
        if (!disabled) return;
        menuOpen.value = false;
    });
    watch(
        () => props.disabled,
        (disabled) => {
            if (!disabled) return;
            void privacyApi
                .releaseModels()
                .catch(() => log.warn('[PrivacyProtection] Could not unload the local model'));
        }
    );
    watch(
        selectedModel,
        (model) => {
            if (model) emit('update:modelDataTypes', [...model.dataTypes]);
        },
        { immediate: true }
    );

    onMounted(async () => {
        try {
            const stop = await privacyApi.onDownloadProgress((payload) => {
                const previous = statuses.value[payload.modelId];
                if (payload.totalBytes > 0 && previous)
                    statuses.value[payload.modelId] = {
                        ...previous,
                        ...payload,
                        downloading: true,
                    };
                if (!payload.totalBytes || payload.downloadedBytes >= payload.totalBytes)
                    void refresh(payload.modelId);
            });
            if (disposed) {
                stop();
                return;
            }
            unlisten = stop;
        } catch {
            log.warn('[PrivacyProtection] Could not subscribe to model status');
        }
        if (!disposed) await refresh();
    });
    onBeforeUnmount(() => {
        disposed = true;
        unlisten?.();
    });
</script>

<template>
    <section ref="modelSection" class="space-y-4">
        <h2 class="settings-section-title">{{ t('settings.privacyFilter.section.localModel') }}</h2>
        <div class="settings-row-group divide-y divide-border/70">
            <SettingsRow
                data-settings-search-target="privacy-filter-model-manager"
                control-width="320"
                :label="t('settings.privacyFilter.model')"
                :description="
                    statusFailed
                        ? t('settings.privacyFilter.modelStatusUnavailable')
                        : activationRequested && !installed
                          ? t('settings.privacyFilter.activation.downloadRequired')
                          : undefined
                "
            >
                <CustomSelect
                    v-model:open="menuOpen"
                    :model-value="installed ? selectedId : ''"
                    :options="options"
                    :disabled="selectorDisabled"
                    :aria-label="t('settings.privacyFilter.model')"
                    :placeholder="t('settings.privacyFilter.modelSelect')"
                    protect-option-text
                    trigger-test-id="privacy-filter-model-select"
                    content-test-id="privacy-filter-model-options"
                    option-test-id-prefix="privacy-filter-model-"
                    @update:model-value="selectModel"
                >
                    <template #trigger>
                        <span class="flex min-w-0 flex-1 items-center gap-2">
                            <span class="min-w-0 truncate">
                                {{
                                    installed
                                        ? selectedModel?.name
                                        : t('settings.privacyFilter.modelSelect')
                                }}
                            </span>
                            <Badge
                                v-if="installed && selectedModel?.recommended"
                                variant="tag"
                                size="sm"
                                tone="green"
                            >
                                {{ t('settings.privacyFilter.modelRecommended') }}
                            </Badge>
                        </span>
                    </template>
                    <template #option-actions="{ option }">
                        <Badge
                            v-if="models.find((model) => model.id === option.value)?.recommended"
                            variant="tag"
                            size="sm"
                            tone="green"
                            data-testid="privacy-filter-model-recommended"
                        >
                            {{ t('settings.privacyFilter.modelRecommended') }}
                        </Badge>
                        <template v-if="statuses[option.value]?.downloading">
                            <AppIcon
                                name="loading"
                                class="h-4 w-4 animate-spin"
                                role="status"
                                :aria-label="t('settings.privacyFilter.modelDownloading')"
                            />
                            <Button
                                variant="ghost-neutral"
                                data-testid="privacy-filter-cancel-download"
                                :data-model-id="option.value"
                                :aria-label="`${t('settings.privacyFilter.modelCancel')} (${option.label})`"
                                :title="t('settings.privacyFilter.modelCancel')"
                                :disabled="controlsDisabled || cancellingModel === option.value"
                                @click="cancelDownload(option.value)"
                            >
                                <AppIcon name="x" class="h-4 w-4" />
                            </Button>
                        </template>
                        <Button
                            v-else-if="statuses[option.value]?.installed"
                            variant="ghost-neutral"
                            data-testid="privacy-filter-delete-model"
                            :data-model-id="option.value"
                            :aria-label="`${t('settings.privacyFilter.modelDelete')} (${option.label})`"
                            :title="t('settings.privacyFilter.modelDelete')"
                            :disabled="
                                controlsDisabled || Boolean(busyModel) || Boolean(downloading)
                            "
                            @click="deleteModel(option.value)"
                        >
                            <AppIcon name="trash" class="h-4 w-4" />
                        </Button>
                        <Button
                            v-else-if="statusFailed || !statuses[option.value]"
                            variant="ghost-neutral"
                            data-testid="privacy-filter-model-retry"
                            :data-model-id="option.value"
                            :aria-label="t('common.retry')"
                            :disabled="controlsDisabled || refreshing"
                            @click="refresh()"
                        >
                            <AppIcon name="refresh" class="h-4 w-4" />
                        </Button>
                        <Button
                            v-else
                            variant="ghost-neutral"
                            data-testid="privacy-filter-download-model"
                            :data-model-id="option.value"
                            :aria-label="`${t('settings.privacyFilter.modelDownload')} (${option.label})`"
                            :title="t('settings.privacyFilter.modelDownload')"
                            :disabled="
                                controlsDisabled ||
                                !models.find((model) => model.id === option.value)?.supported ||
                                !statuses[option.value] ||
                                Boolean(busyModel) ||
                                Boolean(downloading)
                            "
                            @click="downloadModel(option.value)"
                        >
                            <AppIcon name="download" class="h-4 w-4" />
                        </Button>
                    </template>
                </CustomSelect>
            </SettingsRow>
            <SettingsRow
                data-settings-search-target="privacy-filter-confidence"
                control-width="320"
                :label="t('settings.privacyFilter.confidenceThreshold')"
                :description="t('settings.privacyFilter.confidenceThreshold.description')"
            >
                <Input
                    type="number"
                    variant="filled"
                    min="0"
                    max="1"
                    step="0.05"
                    :model-value="confidenceThreshold"
                    :disabled="disabled || !installed"
                    :aria-label="t('settings.privacyFilter.confidenceThreshold')"
                    data-testid="privacy-filter-confidence-threshold"
                    @update:model-value="setConfidence"
                />
            </SettingsRow>
            <slot name="failure-action" />
        </div>
    </section>
</template>
