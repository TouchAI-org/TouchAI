<script setup lang="ts">
    import CustomSelect from '@components/CustomSelect.vue';
    import SettingsRow from '@components/SettingsRow.vue';
    import { Badge } from '@components/ui/badge';
    import { Switch } from '@components/ui/switch';
    import { useAlert } from '@composables/useAlert';
    import { log } from '@services/ObservabilityService';
    import { storeToRefs } from 'pinia';
    import { computed, onBeforeUnmount, ref, watch } from 'vue';

    import { type MessageKey, t } from '@/i18n';
    import {
        parsePrivacyFilterSettings,
        PRIVACY_DATA_TYPES,
        type PrivacyDataType,
        type PrivacyFilterCategory,
        type PrivacyFilterSettings,
        RULE_DATA_TYPES,
        serializePrivacyFilterSettings,
    } from '@services/SettingsService/domain';
    import { useSettingsStore } from '@/stores/settings';

    import PrivacyList from './PrivacyList.vue';
    import PrivacyModels from './PrivacyModels.vue';
    import PrivacyProtectionRecords from './PrivacyProtectionRecords.vue';

    defineOptions({ name: 'SettingsPrivacyFilterSection' });
    type PrivacyListKey = 'maskedWords' | 'secretPrefixes';
    type FilterMode = 'rules' | 'model';
    interface ListDefinition {
        key: PrivacyListKey;
        labelKey: MessageKey;
        placeholderKey: MessageKey;
        searchTarget: string;
    }
    const settingsStore = useSettingsStore();
    const { settings } = storeToRefs(settingsStore);
    const alert = useAlert();
    const draft = ref(cloneSettings(settings.value.privacyFilterSettings));
    const modelDataTypes = ref<PrivacyDataType[]>([...PRIVACY_DATA_TYPES]);
    const saveState = ref<'idle' | 'saving' | 'error'>('idle');
    let syncingFromStore = false;
    let saving = false;
    let persistedSnapshot = serializePrivacyFilterSettings(draft.value);
    const settingsDisabled = computed(() => !draft.value.enabled);
    const modeOptions = computed(() => [
        { value: 'model' as const, label: t('settings.privacyFilter.mode.model') },
        { value: 'rules' as const, label: t('settings.privacyFilter.mode.rules') },
    ]);
    const filterMode = computed<FilterMode>({
        get: () => (draft.value.useLocalModel ? 'model' : 'rules'),
        set: (mode) => {
            if (!settingsDisabled.value) draft.value.useLocalModel = mode === 'model';
        },
    });
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
        const visibleCategories = draft.value.useLocalModel
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
            placeholderKey: 'settings.privacyFilter.maskedWords.placeholder',
            searchTarget: 'privacy-filter-masked-words',
        },
        {
            key: 'secretPrefixes',
            labelKey: 'settings.privacyFilter.secretPrefixes',
            placeholderKey: 'settings.privacyFilter.secretPrefixes.placeholder',
            searchTarget: 'privacy-filter-secret-prefixes',
        },
    ]);
    watch(
        () => settings.value.privacyFilterSettings,
        (value) => {
            if (syncingFromStore) return;
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
        if (serializePrivacyFilterSettings(draft.value) !== persistedSnapshot) void saveSettings();
    });

    function cloneSettings(value: PrivacyFilterSettings) {
        return parsePrivacyFilterSettings(serializePrivacyFilterSettings(value));
    }
    async function saveSettings() {
        if (saving || syncingFromStore) return;
        const snapshot = cloneSettings(draft.value);
        const serialized = serializePrivacyFilterSettings(snapshot);
        if (serialized === persistedSnapshot) return;
        saving = true;
        saveState.value = 'saving';
        syncingFromStore = true;
        try {
            await settingsStore.updatePrivacyFilterSettings(snapshot);
            persistedSnapshot = serialized;
            saveState.value = 'idle';
        } catch (error) {
            saveState.value = 'error';
            log.error('[PrivacyProtection] Failed to save settings:', error);
            alert.error(t('settings.privacyFilter.saveFailed'));
        } finally {
            saving = false;
            syncingFromStore = false;
            if (serializePrivacyFilterSettings(draft.value) !== serialized) void saveSettings();
        }
    }
    function setCategoryEnabled(category: PrivacyFilterCategory, enabled: boolean) {
        if (!settingsDisabled.value) draft.value.categories[category] = enabled;
    }
    function listLabel(list: ListDefinition): string {
        return t(list.labelKey);
    }
    function listPlaceholder(list: ListDefinition): string {
        return t(list.placeholderKey);
    }
    function addListItem(key: PrivacyListKey, value: string) {
        if (settingsDisabled.value) return;
        const normalized = value.trim();
        if (!normalized || normalized.length > 256 || draft.value[key].length >= 500) return;
        if (
            !draft.value[key].some(
                (item) => item.toLocaleLowerCase() === normalized.toLocaleLowerCase()
            )
        )
            draft.value[key] = [...draft.value[key], normalized];
    }
    function removeListItem(key: PrivacyListKey, value: string) {
        if (!settingsDisabled.value)
            draft.value[key] = draft.value[key].filter((item) => item !== value);
    }
</script>

<template>
    <div class="settings-page" data-testid="settings-privacy-filter-section">
        <div class="settings-section-stack">
            <header class="settings-page-header flex items-start gap-4">
                <div class="max-w-2xl min-w-0">
                    <h1 class="settings-page-title" data-testid="privacy-filter-settings-title">
                        {{ t('settings.privacyFilter.title') }}
                    </h1>
                    <p class="settings-section-description">
                        {{ t('settings.privacyFilter.description') }}
                    </p>
                </div>
                <Switch
                    size="lg"
                    class="ml-auto shrink-0"
                    data-testid="privacy-filter-enabled-toggle"
                    data-settings-search-target="privacy-filter-enabled"
                    :aria-label="t('settings.privacyFilter.enabled')"
                    :model-value="draft.enabled"
                    @update:model-value="draft.enabled = $event"
                />
            </header>

            <fieldset :disabled="settingsDisabled" class="settings-section-stack">
                <div class="settings-row-group">
                    <SettingsRow
                        data-settings-search-target="privacy-filter-mode"
                        control-width="320"
                        :label="t('settings.privacyFilter.mode.label')"
                    >
                        <CustomSelect
                            v-model="filterMode"
                            trigger-test-id="privacy-filter-mode-select"
                            option-test-id-prefix="privacy-filter-mode-"
                            :aria-label="t('settings.privacyFilter.mode.label')"
                            :options="modeOptions"
                            :disabled="settingsDisabled"
                        />
                    </SettingsRow>
                </div>

                <PrivacyModels
                    v-if="draft.useLocalModel"
                    v-model:confidence-threshold="draft.confidenceThreshold"
                    :disabled="settingsDisabled"
                    @update:model-data-types="modelDataTypes = $event"
                />

                <section class="space-y-4" aria-labelledby="privacy-filter-scope-title">
                    <h2 id="privacy-filter-scope-title" class="settings-section-title">
                        {{
                            t(
                                draft.useLocalModel
                                    ? 'settings.privacyFilter.section.modelCategories'
                                    : 'settings.privacyFilter.section.ruleCategories'
                            )
                        }}
                    </h2>
                    <div
                        class="settings-row-group px-5 py-4"
                        data-settings-search-target="privacy-filter-scope"
                    >
                        <div
                            class="flex min-w-0 flex-wrap gap-2"
                            role="group"
                            :aria-label="
                                t(
                                    draft.useLocalModel
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
                    </div>
                </section>

                <div
                    v-if="!draft.useLocalModel"
                    class="settings-row-group divide-y divide-border/70"
                >
                    <SettingsRow
                        v-for="list in customRuleLists"
                        :key="list.key"
                        :data-settings-search-target="list.searchTarget"
                        control-width="320"
                        :label="listLabel(list)"
                        control-class="space-y-2"
                    >
                        <PrivacyList
                            :items="draft[list.key]"
                            :label="listLabel(list)"
                            :placeholder="listPlaceholder(list)"
                            :test-id="list.key"
                            :disabled="settingsDisabled"
                            @add="addListItem(list.key, $event)"
                            @remove="removeListItem(list.key, $event)"
                        />
                    </SettingsRow>
                </div>
                <PrivacyProtectionRecords :disabled="settingsDisabled" />
            </fieldset>

            <p v-if="saveState === 'error'" class="text-xs text-text-danger" role="alert">
                {{ t('settings.privacyFilter.saveFailed') }}
            </p>
        </div>
    </div>
</template>
