<script setup lang="ts">
    import CustomSelect from '@components/CustomSelect.vue';
    import SettingsRow from '@components/SettingsRow.vue';
    import { Badge } from '@components/ui/badge';
    import { Switch } from '@components/ui/switch';
    import { useAlert } from '@composables/useAlert';
    import { storeToRefs } from 'pinia';
    import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';

    import { log } from '@/app/api/diagnostics';
    import {
        DEFAULT_PRIVACY_MODEL_ID,
        parsePrivacyFilterSettings,
        PRIVACY_DATA_TYPES,
        type PrivacyDataType,
        type PrivacyFilterCategory,
        type PrivacyFilterFailureAction,
        type PrivacyFilterModelId,
        type PrivacyFilterSettings,
        RULE_DATA_TYPES,
        serializePrivacyFilterSettings,
        usePrivacyApi,
    } from '@/app/api/privacy';
    import { type MessageKey, t } from '@/i18n';
    import { usePrivacyStore } from '@/stores/privacy';

    import PrivacyList from './PrivacyList.vue';
    import PrivacyModeChoices from './PrivacyModeChoices.vue';
    import PrivacyModels from './PrivacyModels.vue';
    import PrivacyProtectionRecords from './PrivacyProtectionRecords.vue';

    defineOptions({ name: 'SettingsPrivacyFilterSection' });
    type PrivacyListKey = 'maskedWords' | 'secretPrefixes';
    type FilterMode = 'rules' | 'model';
    interface ListDefinition {
        key: PrivacyListKey;
        labelKey: MessageKey;
        descriptionKey: MessageKey;
        placeholderKey: MessageKey;
        searchTarget: string;
    }
    type ActivationPhase = 'checking' | 'verifying' | 'saving';
    interface ActivationRun {
        cancelled: boolean;
        verified: boolean;
        submitted?: string;
    }
    const privacyApi = usePrivacyApi();
    const settingsStore = usePrivacyStore();
    const { privacyFilterSettings, privacyFilterFailureAction } = storeToRefs(settingsStore);
    const alert = useAlert();
    const draft = ref(cloneSettings(privacyFilterSettings.value));
    const modelDataTypes = ref<PrivacyDataType[]>([...PRIVACY_DATA_TYPES]);
    const saveState = ref<'idle' | 'saving' | 'error'>('idle');
    const savingFailureAction = ref(false);
    const activationPhase = ref<ActivationPhase | null>(null);
    const activationFailed = ref(false);
    const activationRequested = ref(false);
    const modelManager = ref<InstanceType<typeof PrivacyModels> | null>(null);
    const showLocalModel = computed(() => draft.value.useLocalModel || activationRequested.value);
    let syncingFromStore = false;
    let savePromise: Promise<boolean> | null = null;
    let activeRun: ActivationRun | null = null;
    let disposed = false;
    let persistedSnapshot = serializePrivacyFilterSettings(draft.value);
    let savingSnapshot: string | undefined;
    let externalRevision = 0;
    const settingsDisabled = computed(() => !draft.value.enabled || Boolean(activationPhase.value));
    const toggleDisabled = computed(
        () =>
            Boolean(activationPhase.value) || (saveState.value === 'saving' && !draft.value.enabled)
    );
    const filterMode = computed<FilterMode>({
        get: () => (showLocalModel.value ? 'model' : 'rules'),
        set: (mode) => {
            if (!settingsDisabled.value) draft.value.useLocalModel = mode === 'model';
        },
    });
    const failureActions: readonly PrivacyFilterFailureAction[] = [
        'block',
        'fallback-rules',
        'send-original',
    ];
    const failureActionOptions = computed(() =>
        failureActions.map((value) => ({
            value,
            label: t(`settings.privacyFilter.failureAction.option.${value}`),
        }))
    );
    const failureActionDescription = computed(() =>
        t(`settings.privacyFilter.failureAction.description.${privacyFilterFailureAction.value}`)
    );
    const categoryRows = computed(() => {
        const labels: Record<PrivacyDataType, MessageKey> = {
            email: 'settings.privacyFilter.type.email',
            phone: 'settings.privacyFilter.type.phone',
            privatePerson: 'settings.privacyFilter.type.person',
            privateAddress: 'settings.privacyFilter.type.address',
            privateDate: 'settings.privacyFilter.type.date',
            account: 'settings.privacyFilter.type.account',
            paymentCard: 'settings.privacyFilter.type.paymentCard',
            ipAddress: 'settings.privacyFilter.type.ipAddress',
            url: 'settings.privacyFilter.type.url',
        };
        const secretLabel: MessageKey = 'settings.privacyFilter.records.kind.secret';
        const visibleCategories = showLocalModel.value
            ? PRIVACY_DATA_TYPES.filter((category) => modelDataTypes.value.includes(category))
            : RULE_DATA_TYPES;
        return (['secrets', ...visibleCategories] as PrivacyFilterCategory[]).map((category) => ({
            category,
            label: category === 'secrets' ? t(secretLabel) : t(labels[category]),
        }));
    });
    const customRuleLists = computed<ListDefinition[]>(() => [
        {
            key: 'maskedWords',
            labelKey: 'settings.privacyFilter.maskedWords',
            descriptionKey: 'settings.privacyFilter.maskedWords.description',
            placeholderKey: 'settings.privacyFilter.maskedWords.placeholder',
            searchTarget: 'privacy-filter-masked-words',
        },
        {
            key: 'secretPrefixes',
            labelKey: 'settings.privacyFilter.secretPrefixes',
            descriptionKey: 'settings.privacyFilter.secretPrefixes.description',
            placeholderKey: 'settings.privacyFilter.secretPrefixes.placeholder',
            searchTarget: 'privacy-filter-secret-prefixes',
        },
    ]);
    watch(
        () => privacyFilterSettings.value,
        (value) => {
            if (serializePrivacyFilterSettings(value) === savingSnapshot) return;
            externalRevision += 1;
            if (activeRun || activationRequested.value) cancelActivation(true);
            syncingFromStore = true;
            draft.value = cloneSettings(value);
            persistedSnapshot = serializePrivacyFilterSettings(draft.value);
            queueMicrotask(() => {
                syncingFromStore = false;
            });
        },
        { deep: true }
    );
    watch(draft, saveSettings, { deep: true });
    onBeforeUnmount(() => {
        disposed = true;
        cancelActivation();
        if (serializePrivacyFilterSettings(draft.value) !== persistedSnapshot) void saveSettings();
    });

    function cloneSettings(value: PrivacyFilterSettings) {
        return parsePrivacyFilterSettings(serializePrivacyFilterSettings(value));
    }
    function saveSettings(): Promise<boolean> {
        if (savePromise) return savePromise;
        if (syncingFromStore) return Promise.resolve(true);
        const pending = persistSettings();
        savePromise = pending;
        void pending.then(() => {
            if (savePromise === pending) savePromise = null;
        });
        return pending;
    }
    async function persistSettings(): Promise<boolean> {
        while (serializePrivacyFilterSettings(draft.value) !== persistedSnapshot) {
            const snapshot = cloneSettings(draft.value);
            const serialized = serializePrivacyFilterSettings(snapshot);
            const revision = externalRevision;
            savingSnapshot = serialized;
            saveState.value = 'saving';
            syncingFromStore = true;
            try {
                await settingsStore.updatePrivacyFilterSettings(snapshot);
                if (revision === externalRevision) persistedSnapshot = serialized;
                saveState.value = 'idle';
            } catch (error) {
                draft.value = cloneSettings(privacyFilterSettings.value);
                persistedSnapshot = serializePrivacyFilterSettings(draft.value);
                saveState.value = 'error';
                log.error('[PrivacyProtection] Failed to save settings:', error);
                if (!disposed) alert.error(t('settings.privacyFilter.saveFailed'));
                return false;
            } finally {
                savingSnapshot = undefined;
                syncingFromStore = false;
            }
        }
        return true;
    }
    async function setFailureAction(value: PrivacyFilterFailureAction) {
        if (
            settingsDisabled.value ||
            !draft.value.useLocalModel ||
            savingFailureAction.value ||
            value === privacyFilterFailureAction.value
        )
            return;
        savingFailureAction.value = true;
        try {
            await settingsStore.updatePrivacyFilterFailureAction(value);
        } catch {
            log.warn('[PrivacyProtection] Could not save the masking failure action');
            if (!disposed) alert.error(t('settings.privacyFilter.saveFailed'));
        } finally {
            savingFailureAction.value = false;
        }
    }
    function isCurrent(run: ActivationRun) {
        return !disposed && activeRun === run && !run.cancelled && activationRequested.value;
    }
    function cancelActivation(external = false) {
        activationRequested.value = false;
        const run = activeRun;
        if (!run || run.cancelled) return;
        run.cancelled = true;
        if (!external && run.submitted === serializePrivacyFilterSettings(draft.value)) {
            draft.value.enabled = false;
            void saveSettings();
        }
    }
    async function setEnabled(enabled: boolean) {
        if (toggleDisabled.value || activeRun || disposed) return;
        activationFailed.value = false;
        saveState.value = 'idle';
        if (!enabled) {
            cancelActivation();
            draft.value.enabled = false;
            await saveSettings();
            return;
        }
        activationRequested.value = true;
        await activateRequestedModel();
    }
    async function activateRequestedModel(
        modelId: PrivacyFilterModelId = DEFAULT_PRIVACY_MODEL_ID
    ) {
        if (!activationRequested.value || activeRun || disposed) return;
        const run: ActivationRun = { cancelled: false, verified: false };
        activeRun = run;
        activationPhase.value = 'checking';
        let needsDownload = false;
        try {
            const status = await privacyApi.getModelStatus(modelId);
            if (!isCurrent(run)) return;
            if (!status.installed || status.downloading) {
                needsDownload = true;
                return;
            }
            activationPhase.value = 'verifying';
            run.verified = true;
            // A nonempty probe loads, integrity-checks and executes the local model.
            const result = await privacyApi.detect(
                ['Local privacy protection readiness check.'],
                modelId
            );
            if (!isCurrent(run)) return;
            if (!Array.isArray(result) || result.length !== 1 || !Array.isArray(result[0]))
                throw new Error('Invalid model verification response');
            activationPhase.value = 'saving';
            await settingsStore.updatePrivacyFilterModelId(modelId);
            if (!isCurrent(run)) return;
            draft.value = { ...draft.value, enabled: true, useLocalModel: true };
            run.submitted = serializePrivacyFilterSettings(draft.value);
            const saved = await saveSettings();
            if (isCurrent(run)) {
                activationFailed.value = !saved;
                activationRequested.value = false;
            }
        } catch {
            if (isCurrent(run)) {
                activationFailed.value = true;
                activationRequested.value = false;
                log.warn('[PrivacyProtection] Local-model activation failed', {
                    phase: activationPhase.value,
                });
            }
        } finally {
            if (run.verified && !draft.value.enabled) {
                await privacyApi
                    .releaseModels()
                    .catch(() => log.warn('[PrivacyProtection] Could not unload the local model'));
            }
            if (activeRun === run) {
                activeRun = null;
                activationPhase.value = null;
            }
            if (needsDownload && activationRequested.value && !disposed && !activeRun) {
                await nextTick();
                if (activationRequested.value && !disposed && !activeRun)
                    await modelManager.value?.requestDownload();
            }
        }
    }
    function setCategoryEnabled(category: PrivacyFilterCategory, enabled: boolean) {
        if (!settingsDisabled.value) draft.value.categories[category] = enabled;
    }
    function addListItem(key: PrivacyListKey, value: string) {
        if (settingsDisabled.value) return;
        const additions = value
            .split(/[,，\r\n]+/)
            .map((item) => item.trim())
            .filter(Boolean);
        if (!additions.length || draft.value[key].length >= 500) return;
        draft.value[key] = cloneSettings({
            ...draft.value,
            [key]: [...draft.value[key], ...additions],
        })[key];
    }
    function removeListItem(key: PrivacyListKey, value: string) {
        if (!settingsDisabled.value)
            draft.value[key] = draft.value[key].filter((item) => item !== value);
    }
</script>

<template>
    <div class="settings-page" data-testid="settings-privacy-filter-section">
        <div class="settings-section-stack">
            <PrivacyProtectionRecords :disabled="settingsDisabled">
                <template #heading>
                    <header class="flex items-start gap-4">
                        <div class="max-w-2xl min-w-0">
                            <h1
                                class="settings-page-title"
                                data-testid="privacy-filter-settings-title"
                            >
                                {{ t('settings.privacyFilter.title') }}
                            </h1>
                        </div>
                        <Switch
                            size="lg"
                            class="ml-auto shrink-0"
                            data-testid="privacy-filter-enabled-toggle"
                            data-settings-search-target="privacy-filter-enabled"
                            :aria-label="t('settings.privacyFilter.enabled')"
                            :model-value="draft.enabled || activationRequested"
                            :disabled="toggleDisabled"
                            :aria-busy="toggleDisabled"
                            @update:model-value="setEnabled"
                        />
                    </header>
                </template>
                <template #description>
                    <div class="min-w-0 space-y-2">
                        <p class="text-dense leading-relaxed text-text-secondary">
                            {{ t('settings.privacyFilter.description') }}
                        </p>
                        <p
                            v-if="activationFailed"
                            class="text-xs text-text-danger"
                            role="alert"
                            data-testid="privacy-filter-activation-error"
                        >
                            {{ t('settings.privacyFilter.activation.failed') }}
                        </p>
                    </div>
                </template>
                <div class="settings-section-stack">
                    <section class="space-y-4">
                        <h2 class="settings-section-title">
                            {{ t('settings.privacyFilter.section.basic') }}
                        </h2>
                        <div class="settings-row-group divide-y divide-border/70">
                            <SettingsRow
                                data-settings-search-target="privacy-filter-mode"
                                control-width="auto"
                                :label="t('settings.privacyFilter.mode.row')"
                            >
                                <PrivacyModeChoices
                                    v-model="filterMode"
                                    :disabled="settingsDisabled"
                                />
                            </SettingsRow>

                            <SettingsRow
                                data-settings-search-target="privacy-filter-scope"
                                control-width="320"
                                :label="t('settings.privacyFilter.categoryRow')"
                                :description="t('settings.privacyFilter.categoryRow.description')"
                                :label-attrs="{ id: 'privacy-filter-scope-title' }"
                                control-class="space-y-2"
                            >
                                <div
                                    class="flex min-w-0 flex-wrap gap-2"
                                    role="group"
                                    :aria-label="
                                        t(
                                            showLocalModel
                                                ? 'settings.privacyFilter.section.modelCategories'
                                                : 'settings.privacyFilter.section.ruleCategories'
                                        )
                                    "
                                >
                                    <Badge
                                        v-for="row in categoryRows"
                                        :key="row.category"
                                        as="button"
                                        type="button"
                                        variant="toggle"
                                        tone="blue"
                                        class="disabled:pointer-events-none disabled:opacity-50"
                                        :disabled="settingsDisabled"
                                        :active="draft.categories[row.category]"
                                        :aria-pressed="draft.categories[row.category]"
                                        :data-testid="`privacy-filter-category-${row.category}`"
                                        @click="
                                            setCategoryEnabled(
                                                row.category,
                                                !draft.categories[row.category]
                                            )
                                        "
                                    >
                                        {{ row.label }}
                                    </Badge>
                                </div>
                            </SettingsRow>

                            <SettingsRow
                                v-for="list in customRuleLists"
                                :key="list.key"
                                :data-settings-search-target="list.searchTarget"
                                control-width="320"
                                :label="t(list.labelKey)"
                                :description="t(list.descriptionKey)"
                                control-class="space-y-2"
                            >
                                <PrivacyList
                                    :items="draft[list.key]"
                                    :label="t(list.labelKey)"
                                    :placeholder="t(list.placeholderKey)"
                                    :test-id="list.key"
                                    :disabled="settingsDisabled"
                                    @add="addListItem(list.key, $event)"
                                    @remove="removeListItem(list.key, $event)"
                                />
                            </SettingsRow>
                        </div>
                    </section>

                    <PrivacyModels
                        v-if="showLocalModel"
                        ref="modelManager"
                        v-model:confidence-threshold="draft.confidenceThreshold"
                        :disabled="settingsDisabled"
                        :activation-requested="
                            activationRequested && !activationPhase && saveState !== 'saving'
                        "
                        @update:model-data-types="modelDataTypes = $event"
                        @model-ready="activateRequestedModel"
                        @cancel-activation="cancelActivation"
                    >
                        <template #failure-action>
                            <SettingsRow
                                data-settings-search-target="privacy-filter-failure-action"
                                :label="t('settings.privacyFilter.failureAction.label')"
                                :description="failureActionDescription"
                            >
                                <CustomSelect
                                    :model-value="privacyFilterFailureAction"
                                    :options="failureActionOptions"
                                    :disabled="settingsDisabled || savingFailureAction"
                                    :aria-label="t('settings.privacyFilter.failureAction.label')"
                                    :aria-busy="savingFailureAction"
                                    trigger-test-id="privacy-filter-failure-action"
                                    content-test-id="privacy-filter-failure-options"
                                    option-test-id-prefix="privacy-filter-failure-"
                                    @update:model-value="setFailureAction"
                                />
                            </SettingsRow>
                        </template>
                    </PrivacyModels>
                </div>
            </PrivacyProtectionRecords>

            <p
                v-if="saveState === 'error' && !activationFailed"
                class="text-xs text-text-danger"
                role="alert"
            >
                {{ t('settings.privacyFilter.saveFailed') }}
            </p>
        </div>
    </div>
</template>
