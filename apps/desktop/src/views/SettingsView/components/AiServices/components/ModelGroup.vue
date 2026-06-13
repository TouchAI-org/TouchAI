<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import { useConfirm } from '@composables/useConfirm';
    import type { Model } from '@database/schema';
    import { computed } from 'vue';
    import { ref } from 'vue';

    import { t } from '@/i18n';

    import ModelCard from './ModelCard.vue';
    interface ModelGroup {
        groupKey: string;
        groupName: string;
        models: Model[];
    }

    interface Props {
        group: ModelGroup;
        defaultModelId: number | null;
        providerEnabled: boolean;
        multiSelectMode?: boolean;
        selectedModelIds?: Set<number>;
        area?: 'support' | 'selection';
    }

    interface Emits {
        (e: 'update', id: number, data: Partial<Model>): void;
        (e: 'delete', id: number): void;
        (e: 'delete-group', groupKey: string): void;
        (e: 'set-default', id: number): void;
        (e: 'edit', model: Model): void;
        (e: 'toggle-select', id: number): void;
        (e: 'add-to-selection', model: Model): void;
        (e: 'remove-from-selection', model: Model): void;
    }

    const props = withDefaults(defineProps<Props>(), {
        multiSelectMode: false,
        selectedModelIds: () => new Set(),
        area: 'selection',
    });
    const emit = defineEmits<Emits>();

    const { confirm } = useConfirm();

    const isExpanded = ref(true);

    const toggleExpand = () => {
        isExpanded.value = !isExpanded.value;
    };

    const isGroupFullySelected = computed(() => {
        if (!props.multiSelectMode || props.group.models.length === 0) return false;
        return props.group.models.every((model) => props.selectedModelIds.has(model.id));
    });

    const isGroupPartiallySelected = computed(() => {
        if (!props.multiSelectMode) return false;
        return (
            !isGroupFullySelected.value &&
            props.group.models.some((model) => props.selectedModelIds.has(model.id))
        );
    });

    const toggleGroupSelect = () => {
        const groupIds = props.group.models.map((m) => m.id);
        if (isGroupFullySelected.value) {
            groupIds.forEach((id) => {
                if (props.selectedModelIds.has(id)) emit('toggle-select', id);
            });
        } else {
            groupIds.forEach((id) => {
                if (!props.selectedModelIds.has(id)) emit('toggle-select', id);
            });
        }
    };

    const handleDeleteGroup = async (groupKey: string, models: Model[]) => {
        const hasDefaultModel = models.some((model) => model.id === props.defaultModelId);

        if (hasDefaultModel) {
            const { useAlert } = await import('@composables/useAlert');
            const { warning } = useAlert();
            warning(t('settings.ai.groupContainsDefaultModel'));
            return;
        }

        const confirmed = await confirm({
            title: t('settings.ai.confirmDeleteTitle'),
            message: t('settings.ai.confirmDeleteGroup'),
            type: 'danger',
            confirmText: t('common.delete'),
            cancelText: t('common.cancel'),
        });

        if (confirmed) {
            emit('delete-group', groupKey);
        }
    };
</script>

<template>
    <div class="model-group border-b border-neutral-100 py-2 last:border-b-0">
        <div class="flex items-center gap-2">
            <button
                class="flex flex-1 items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors hover:bg-neutral-50"
                @click="toggleExpand"
            >
                <AppIcon
                    name="chevron-right"
                    :class="
                        isExpanded
                            ? 'h-4 w-4 rotate-90 text-neutral-400 transition-transform'
                            : 'h-4 w-4 text-neutral-400 transition-transform'
                    "
                />

                <input
                    v-if="multiSelectMode"
                    type="checkbox"
                    :checked="isGroupFullySelected"
                    :indeterminate="isGroupPartiallySelected"
                    class="text-primary-600 focus:ring-primary-500 h-4 w-4 rounded border-neutral-300"
                    @click.stop="toggleGroupSelect"
                />

                <span class="text-sm font-medium text-neutral-800">
                    {{ group.groupName }}
                </span>

                <span class="text-xs text-neutral-400">({{ group.models.length }})</span>
            </button>

            <button
                v-if="!multiSelectMode"
                class="flex h-7 w-7 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-50 hover:text-neutral-700"
                :title="t('settings.ai.deleteGroup')"
                @click="handleDeleteGroup(group.groupKey, group.models)"
            >
                <AppIcon name="trash" class="h-4 w-4" />
            </button>
        </div>

        <div
            v-show="isExpanded"
            data-testid="settings-model-group-models"
            class="mt-2 ml-6 space-y-2"
        >
            <ModelCard
                v-for="model in group.models"
                :key="model.id"
                :model="model"
                :is-default="model.id === defaultModelId"
                :provider-enabled="providerEnabled"
                :multi-select-mode="multiSelectMode"
                :is-selected="selectedModelIds.has(model.id)"
                :area="area"
                @update="(data) => emit('update', model.id, data)"
                @delete="emit('delete', model.id)"
                @set-default="emit('set-default', model.id)"
                @edit="emit('edit', model)"
                @toggle-select="emit('toggle-select', model.id)"
                @add-to-selection="emit('add-to-selection', model)"
                @remove-from-selection="emit('remove-from-selection', model)"
            />
        </div>
    </div>
</template>
