<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import SvgIcon from '@components/SvgIcon.vue';
    import { useConfirm } from '@composables/useConfirm';
    import type { Model } from '@database/schema';
    import { ref } from 'vue';

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
    }

    interface Emits {
        (e: 'update', id: number, data: Partial<Model>): void;
        (e: 'delete', id: number): void;
        (e: 'delete-group', groupKey: string): void;
        (e: 'set-default', id: number): void;
        (e: 'edit', model: Model): void;
    }

    const props = defineProps<Props>();
    const emit = defineEmits<Emits>();

    const { confirm } = useConfirm();

    const isExpanded = ref(true);

    const toggleExpand = () => {
        isExpanded.value = !isExpanded.value;
    };

    const handleDeleteGroup = async (groupKey: string, models: Model[]) => {
        // 检查分组内是否有默认模型
        const hasDefaultModel = models.some((model) => model.id === props.defaultModelId);

        if (hasDefaultModel) {
            // 如果分组内有默认模型，不允许删除
            const { useAlert } = await import('@composables/useAlert');
            const { warning } = useAlert();
            warning('该分组包含默认模型，无法批量删除');
            return;
        }

        const confirmed = await confirm({
            title: '确认删除',
            message: '确定要删除该分组下的所有模型吗？',
            type: 'danger',
            confirmText: '删除',
            cancelText: '取消',
        });

        if (confirmed) {
            emit('delete-group', groupKey);
        }
    };
</script>

<template>
    <div class="model-group">
        <div class="flex items-center gap-2">
            <button
                class="flex flex-1 items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-gray-50"
                @click="toggleExpand"
            >
                <SvgIcon
                    name="chevron-right"
                    :class="
                        isExpanded
                            ? 'h-4 w-4 rotate-90 text-gray-400 transition-transform'
                            : 'h-4 w-4 text-gray-400 transition-transform'
                    "
                />

                <span class="font-serif text-sm font-medium text-gray-700">
                    {{ group.groupName }}
                </span>

                <span class="text-xs text-gray-400">({{ group.models.length }})</span>
            </button>

            <button
                class="flex h-7 w-7 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
                title="删除分组"
                @click="handleDeleteGroup(group.groupKey, group.models)"
            >
                <SvgIcon name="trash" class="h-4 w-4" />
            </button>
        </div>

        <div v-show="isExpanded" class="mt-2 ml-6 space-y-2">
            <ModelCard
                v-for="model in group.models"
                :key="model.id"
                :model="model"
                :is-default="model.id === defaultModelId"
                :provider-enabled="providerEnabled"
                @update="(data) => emit('update', model.id, data)"
                @delete="emit('delete', model.id)"
                @set-default="emit('set-default', model.id)"
                @edit="emit('edit', model)"
            />
        </div>
    </div>
</template>

<style scoped></style>
