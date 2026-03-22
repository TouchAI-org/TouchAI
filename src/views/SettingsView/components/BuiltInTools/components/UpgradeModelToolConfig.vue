<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import ModelCapabilityTags from '@components/ModelCapabilityTags.vue';
    import ModelLogo from '@components/ModelLogo.vue';
    import SearchableSelect from '@components/SearchableSelect.vue';
    import SvgIcon from '@components/SvgIcon.vue';
    import { findModelsWithProvider } from '@database/queries';
    import type { ModelWithProvider } from '@database/queries/models';
    import { computed, onMounted, ref, watch } from 'vue';
    import type { SortableEvent } from 'vue-draggable-plus';
    import { VueDraggable } from 'vue-draggable-plus';

    import type { UpgradeModelChainEntry } from '@/services/BuiltInToolService/tools/upgradeModel/chain';

    import type { UpgradeModelToolConfig } from '../types';

    interface Props {
        modelValue: UpgradeModelToolConfig;
    }

    interface Emits {
        (e: 'update:modelValue', value: UpgradeModelToolConfig): void;
    }

    interface UpgradeModelSelectOption {
        value: string | number;
        label: string;
        description?: string;
        searchText?: string;
        providerLogo?: string;
        providerName?: string;
        modelIdForLogo?: string;
        modelName?: string;
        attachment?: number | null;
        modalities?: string | null;
        open_weights?: number | null;
        reasoning?: number | null;
        tool_call?: number | null;
    }

    interface UpgradeModelChainRow extends UpgradeModelChainEntry {
        uid: string;
    }

    const props = defineProps<Props>();
    const emit = defineEmits<Emits>();

    const rawProviderLogos = import.meta.glob<{ default: string }>('@assets/logos/providers/*', {
        eager: true,
    });
    const providerLogos: Record<string, string> = {};
    for (const [path, mod] of Object.entries(rawProviderLogos)) {
        const fileName = path.split('/').pop();
        if (fileName && mod.default) {
            providerLogos[fileName] = mod.default;
        }
    }

    const availableModels = ref<ModelWithProvider[]>([]);
    const loading = ref(false);
    const chainRows = ref<UpgradeModelChainRow[]>([]);
    const draggingRowUid = ref<string | null>(null);
    const lastAppliedChainJson = ref('');

    const buildUpgradeModelKey = (entry: UpgradeModelChainEntry): string =>
        `${entry.providerId}:${entry.modelId}`;

    const cloneChain = (chain: UpgradeModelChainEntry[]): UpgradeModelChainEntry[] =>
        chain.map((entry) => ({ ...entry }));

    const rowsToChain = (rows: UpgradeModelChainRow[]): UpgradeModelChainEntry[] =>
        rows.map(({ providerId, modelId }) => ({
            providerId,
            modelId,
        }));

    function createChainRow(entry: UpgradeModelChainEntry, uid?: string) {
        return {
            uid: uid ?? crypto.randomUUID(),
            providerId: entry.providerId,
            modelId: entry.modelId,
        };
    }

    const enabledModels = computed(() =>
        availableModels.value.filter((model) => model.provider_enabled === 1)
    );

    const nextAppendEntry = computed<UpgradeModelChainEntry | null>(() => {
        const usedKeys = new Set(chainRows.value.map(buildUpgradeModelKey));

        for (const model of enabledModels.value) {
            const entry = {
                providerId: model.provider_id,
                modelId: model.model_id,
            };

            if (!usedKeys.has(buildUpgradeModelKey(entry))) {
                return entry;
            }
        }

        return null;
    });

    function resolveModel(entry: UpgradeModelChainEntry): ModelWithProvider | undefined {
        return availableModels.value.find(
            (model) => model.provider_id === entry.providerId && model.model_id === entry.modelId
        );
    }

    function resolveProviderLogoPath(logo?: string): string {
        return (logo && providerLogos[logo]) || '';
    }

    function getProviderFallbackText(option: UpgradeModelSelectOption | null): string {
        return option?.label?.charAt(0) || '?';
    }

    function getChainJson(chain: UpgradeModelChainEntry[]): string {
        return JSON.stringify(cloneChain(chain));
    }

    /**
     * 配置页会在本地编辑、父层回写和自动保存之间频繁同步。
     * 这里按“模型链内容”复用已有行标识，避免每次回写都把整行节点视为新项，
     * 否则拖拽过程态会丢失，输入中的下拉也容易闪烁。
     */
    function applyRowsFromConfig(chain: UpgradeModelChainEntry[]) {
        const nextChainJson = getChainJson(chain);
        const currentChainJson = getChainJson(rowsToChain(chainRows.value));
        lastAppliedChainJson.value = nextChainJson;

        if (nextChainJson === currentChainJson) {
            return;
        }

        const uidByKey = new Map<string, string>();
        for (const row of chainRows.value) {
            uidByKey.set(buildUpgradeModelKey(row), row.uid);
        }

        chainRows.value = chain.map((entry) =>
            createChainRow(entry, uidByKey.get(buildUpgradeModelKey(entry)))
        );
    }

    function emitCurrentChain() {
        const nextChain = rowsToChain(chainRows.value);
        const nextChainJson = getChainJson(nextChain);
        if (nextChainJson === lastAppliedChainJson.value) {
            return;
        }

        emit('update:modelValue', {
            chain: nextChain,
        });
    }

    function getUsedModelKeys(excludedUid: string): Set<string> {
        return new Set(
            chainRows.value
                .filter((row) => row.uid !== excludedUid)
                .map((entry) => buildUpgradeModelKey(entry))
        );
    }

    /**
     * 服务商和模型下拉都要避开其他卡片已经占用的模型，
     * 否则自动保存时规范化去重会把重复项折叠掉，用户会感觉“卡片自己消失了”。
     */
    function getEnabledModelsForProvider(providerId: number, excludedUid: string) {
        const usedKeys = getUsedModelKeys(excludedUid);

        return enabledModels.value.filter((model) => {
            if (model.provider_id !== providerId) {
                return false;
            }

            return !usedKeys.has(
                buildUpgradeModelKey({
                    providerId: model.provider_id,
                    modelId: model.model_id,
                })
            );
        });
    }

    function getFallbackProviderOption(row: UpgradeModelChainRow): UpgradeModelSelectOption {
        const model = resolveModel(row);

        return {
            value: row.providerId,
            label: model?.provider_name ?? `Provider #${row.providerId}`,
            description:
                model?.provider_enabled === 0 ? '当前已选服务商未启用' : '当前已选服务商不可用',
            searchText: `${model?.provider_name ?? ''} ${model?.provider_type ?? ''}`,
            providerLogo: model?.provider_logo,
            providerName: model?.provider_name,
        };
    }

    function getFallbackModelOption(row: UpgradeModelChainRow): UpgradeModelSelectOption {
        const model = resolveModel(row);

        return {
            value: row.modelId,
            label: model?.name ?? row.modelId,
            description:
                model?.provider_enabled === 0 ? '当前已选模型所属服务商未启用' : row.modelId,
            searchText: `${model?.provider_name ?? ''} ${row.modelId}`,
            modelIdForLogo: row.modelId,
            modelName: model?.name ?? row.modelId,
            providerName: model?.provider_name,
            attachment: model?.attachment,
            modalities: model?.modalities,
            open_weights: model?.open_weights,
            reasoning: model?.reasoning,
            tool_call: model?.tool_call,
        };
    }

    function getProviderOptions(rowUid: string): UpgradeModelSelectOption[] {
        const currentRow = chainRows.value.find((row) => row.uid === rowUid);
        if (!currentRow) {
            return [];
        }

        const providerMap = new Map<number, UpgradeModelSelectOption>();
        for (const model of enabledModels.value) {
            if (providerMap.has(model.provider_id)) {
                continue;
            }

            const providerModels = getEnabledModelsForProvider(model.provider_id, rowUid);
            if (providerModels.length === 0) {
                continue;
            }

            providerMap.set(model.provider_id, {
                value: model.provider_id,
                label: model.provider_name,
                description: `${providerModels.length} 个可选模型`,
                searchText: `${model.provider_name} ${model.provider_type}`,
                providerLogo: model.provider_logo,
                providerName: model.provider_name,
            });
        }

        if (!providerMap.has(currentRow.providerId)) {
            providerMap.set(currentRow.providerId, getFallbackProviderOption(currentRow));
        }

        return [...providerMap.values()];
    }

    function getModelOptions(rowUid: string): UpgradeModelSelectOption[] {
        const currentRow = chainRows.value.find((row) => row.uid === rowUid);
        if (!currentRow) {
            return [];
        }

        const options: UpgradeModelSelectOption[] = getEnabledModelsForProvider(
            currentRow.providerId,
            rowUid
        ).map((model) => ({
            value: model.model_id,
            label: model.name,
            description: model.model_id,
            searchText: `${model.provider_name} ${model.name} ${model.model_id}`,
            modelIdForLogo: model.model_id,
            modelName: model.name,
            providerName: model.provider_name,
            attachment: model.attachment,
            modalities: model.modalities,
            open_weights: model.open_weights,
            reasoning: model.reasoning,
            tool_call: model.tool_call,
        }));

        if (!options.some((option) => option.value === currentRow.modelId)) {
            options.unshift(getFallbackModelOption(currentRow));
        }

        return options;
    }

    function findPreferredModelForProvider(
        rowUid: string,
        providerId: number,
        preferredModelId?: string
    ): ModelWithProvider | undefined {
        const providerModels = getEnabledModelsForProvider(providerId, rowUid);
        if (!preferredModelId) {
            return providerModels[0];
        }

        return (
            providerModels.find((model) => model.model_id === preferredModelId) ?? providerModels[0]
        );
    }

    function addModel() {
        if (!nextAppendEntry.value) {
            return;
        }

        chainRows.value = [...chainRows.value, createChainRow(nextAppendEntry.value)];
        emitCurrentChain();
    }

    function updateProvider(rowUid: string, providerIdValue: string | number) {
        const providerId = Number(providerIdValue);
        if (!Number.isInteger(providerId)) {
            return;
        }

        const nextRows = [...chainRows.value];
        const rowIndex = nextRows.findIndex((row) => row.uid === rowUid);
        const currentRow = nextRows[rowIndex];
        if (!currentRow || currentRow.providerId === providerId) {
            return;
        }

        const nextModel = findPreferredModelForProvider(rowUid, providerId, currentRow.modelId);
        if (!nextModel) {
            return;
        }

        nextRows[rowIndex] = {
            ...currentRow,
            providerId,
            modelId: nextModel.model_id,
        };
        chainRows.value = nextRows;
        emitCurrentChain();
    }

    function updateModel(rowUid: string, modelIdValue: string | number) {
        const modelId = String(modelIdValue).trim();
        if (!modelId) {
            return;
        }

        const nextRows = [...chainRows.value];
        const rowIndex = nextRows.findIndex((row) => row.uid === rowUid);
        const currentRow = nextRows[rowIndex];
        if (!currentRow || currentRow.modelId === modelId) {
            return;
        }

        nextRows[rowIndex] = {
            ...currentRow,
            modelId,
        };
        chainRows.value = nextRows;
        emitCurrentChain();
    }

    function removeModel(rowUid: string) {
        chainRows.value = chainRows.value.filter((row) => row.uid !== rowUid);
        emitCurrentChain();
    }

    function handleDragStart(event: SortableEvent) {
        draggingRowUid.value = (event.item as HTMLElement | null)?.dataset.rowUid ?? null;
    }

    function handleDragEnd() {
        draggingRowUid.value = null;
        emitCurrentChain();
    }

    async function loadModels() {
        loading.value = true;
        try {
            availableModels.value = await findModelsWithProvider();
        } catch (error) {
            console.error('[UpgradeModelToolConfig] Failed to load models:', error);
            availableModels.value = [];
        } finally {
            loading.value = false;
        }
    }

    watch(
        () => getChainJson(props.modelValue.chain),
        () => {
            applyRowsFromConfig(props.modelValue.chain);
        },
        { immediate: true }
    );

    onMounted(() => {
        void loadModels();
    });
</script>

<template>
    <div class="space-y-5">
        <section class="rounded-xl border border-gray-200 bg-white p-5">
            <div class="flex items-center justify-between gap-4">
                <h4 class="font-serif text-sm font-semibold text-gray-900">模型升级链</h4>

                <button
                    type="button"
                    class="text-gray-400 transition-colors hover:text-gray-600 disabled:cursor-not-allowed disabled:opacity-40"
                    :disabled="loading || !nextAppendEntry"
                    @click="addModel"
                >
                    <SvgIcon name="plus" class="h-5 w-5" />
                </button>
            </div>

            <div v-if="chainRows.length === 0" class="mt-4">
                <div
                    class="rounded-xl border border-dashed border-gray-200 bg-gray-50/60 px-4 py-10 text-center font-serif text-sm text-gray-500"
                >
                    {{ loading ? '正在加载模型...' : '暂未配置升级链' }}
                </div>
            </div>

            <VueDraggable
                v-else
                v-model="chainRows"
                tag="div"
                class="mt-4 space-y-3"
                handle=".upgrade-model-drag-handle"
                draggable=".upgrade-model-chain-card"
                :animation="180"
                :disabled="loading || chainRows.length < 2"
                :force-fallback="true"
                :fallback-on-body="true"
                :fallback-tolerance="4"
                fallback-class="upgrade-model-sortable-fallback"
                ghost-class="upgrade-model-sortable-ghost"
                chosen-class="upgrade-model-sortable-chosen"
                drag-class="upgrade-model-sortable-drag"
                @start="handleDragStart"
                @end="handleDragEnd"
            >
                <div
                    v-for="row in chainRows"
                    :key="row.uid"
                    :data-row-uid="row.uid"
                    class="upgrade-model-chain-card rounded-xl border border-gray-200 bg-gray-50/70 p-3 transition-colors"
                    :class="
                        draggingRowUid === row.uid
                            ? 'upgrade-model-chain-card--source-dragging'
                            : ''
                    "
                >
                    <div class="flex items-center gap-3">
                        <button
                            type="button"
                            class="upgrade-model-drag-handle inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-400 transition-colors hover:border-gray-300 hover:text-gray-600"
                            :class="
                                loading || chainRows.length < 2
                                    ? 'cursor-default opacity-50'
                                    : 'cursor-grab active:cursor-grabbing'
                            "
                        >
                            <span class="grid grid-cols-2 gap-[2px]">
                                <span
                                    v-for="dot in 6"
                                    :key="dot"
                                    class="h-[3px] w-[3px] rounded-full bg-current"
                                />
                            </span>
                        </button>

                        <div class="w-44 min-w-0 flex-shrink-0">
                            <SearchableSelect
                                :model-value="row.providerId"
                                :options="getProviderOptions(row.uid)"
                                :disabled="loading"
                                placeholder="服务商"
                                search-placeholder="搜索服务商"
                                empty-text="没有可选服务商"
                                @update:model-value="updateProvider(row.uid, $event)"
                            >
                                <template #selected="{ option }">
                                    <div class="flex min-w-0 items-center gap-2">
                                        <img
                                            v-if="resolveProviderLogoPath(option?.providerLogo)"
                                            :src="resolveProviderLogoPath(option?.providerLogo)"
                                            :alt="
                                                option?.providerName || option?.label || 'provider'
                                            "
                                            class="h-5 w-5 flex-shrink-0 rounded object-contain"
                                        />
                                        <div
                                            v-else
                                            class="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded bg-gray-100 text-[10px] font-semibold text-gray-500"
                                        >
                                            {{ getProviderFallbackText(option) }}
                                        </div>
                                        <span class="truncate">
                                            {{ option?.label || '服务商' }}
                                        </span>
                                    </div>
                                </template>

                                <template #option="{ option }">
                                    <div class="flex min-w-0 items-center gap-2">
                                        <img
                                            v-if="resolveProviderLogoPath(option.providerLogo)"
                                            :src="resolveProviderLogoPath(option.providerLogo)"
                                            :alt="option.providerName || option.label"
                                            class="h-5 w-5 flex-shrink-0 rounded object-contain"
                                        />
                                        <div
                                            v-else
                                            class="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded bg-gray-100 text-[10px] font-semibold text-gray-500"
                                        >
                                            {{ getProviderFallbackText(option) }}
                                        </div>
                                        <div class="min-w-0 flex-1">
                                            <div class="truncate font-serif text-sm font-medium">
                                                {{ option.label }}
                                            </div>
                                            <div
                                                v-if="option.description"
                                                class="mt-0.5 truncate text-xs text-gray-500"
                                            >
                                                {{ option.description }}
                                            </div>
                                        </div>
                                    </div>
                                </template>
                            </SearchableSelect>
                        </div>

                        <div class="min-w-0 flex-1">
                            <SearchableSelect
                                :model-value="row.modelId"
                                :options="getModelOptions(row.uid)"
                                :disabled="loading"
                                placeholder="模型"
                                search-placeholder="搜索模型"
                                empty-text="没有可选模型"
                                @update:model-value="updateModel(row.uid, $event)"
                            >
                                <template #selected="{ option }">
                                    <div class="flex min-w-0 items-center gap-2">
                                        <ModelLogo
                                            v-if="option?.modelIdForLogo"
                                            :model-id="option.modelIdForLogo"
                                            :name="option.modelName || option.label"
                                            size="sm"
                                        />
                                        <span class="truncate">
                                            {{ option?.label || '模型' }}
                                        </span>
                                    </div>
                                </template>

                                <template #option="{ option }">
                                    <div class="flex min-w-0 items-center gap-2">
                                        <ModelLogo
                                            v-if="option.modelIdForLogo"
                                            :model-id="option.modelIdForLogo"
                                            :name="option.modelName || option.label"
                                            size="sm"
                                        />
                                        <div class="min-w-0 flex-1">
                                            <div class="truncate font-serif text-sm font-medium">
                                                {{ option.label }}
                                            </div>
                                            <div class="mt-1">
                                                <ModelCapabilityTags
                                                    v-if="
                                                        option.reasoning !== undefined ||
                                                        option.tool_call !== undefined ||
                                                        option.modalities !== undefined ||
                                                        option.attachment !== undefined ||
                                                        option.open_weights !== undefined
                                                    "
                                                    :model="option"
                                                    size="sm"
                                                />
                                                <div
                                                    v-else-if="option.description"
                                                    class="truncate text-xs text-gray-500"
                                                >
                                                    {{ option.description }}
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </template>
                            </SearchableSelect>
                        </div>

                        <button
                            type="button"
                            class="flex-shrink-0 text-gray-400 transition-colors hover:text-red-600"
                            @click="removeModel(row.uid)"
                        >
                            <SvgIcon name="x" class="h-5 w-5" />
                        </button>
                    </div>
                </div>
            </VueDraggable>
        </section>
    </div>
</template>

<style scoped>
    .upgrade-model-drag-handle {
        touch-action: none;
    }

    .upgrade-model-chain-card--source-dragging {
        background: var(--color-primary-50) !important;
        border-color: var(--color-primary-200) !important;
        box-shadow: none !important;
    }

    .upgrade-model-chain-card--source-dragging > div {
        opacity: 0;
    }

    .upgrade-model-sortable-fallback {
        background: #fff !important;
        border-color: var(--color-primary-300) !important;
        box-shadow: 0 18px 42px rgb(107 95 84 / 14%);
    }

    .upgrade-model-sortable-ghost {
        opacity: 1;
        background: var(--color-primary-50) !important;
        border-color: var(--color-primary-200) !important;
        box-shadow: none !important;
    }

    .upgrade-model-sortable-chosen {
        background: var(--color-primary-50) !important;
        border-color: var(--color-primary-300) !important;
        box-shadow: 0 10px 24px rgb(107 95 84 / 10%);
    }

    .upgrade-model-sortable-drag {
        background: #fff !important;
        border-color: var(--color-primary-300) !important;
        box-shadow: 0 18px 42px rgb(107 95 84 / 14%);
    }
</style>
