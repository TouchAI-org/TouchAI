<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import ModelCapabilityTags from '@components/ModelCapabilityTags.vue';
    import ModelLogo from '@components/ModelLogo.vue';
    import { useAlert } from '@composables/useAlert';
    import { useConfirm } from '@composables/useConfirm';
    import type { Model } from '@database/schema';

    interface Props {
        model: Model;
        isDefault: boolean;
        providerEnabled: boolean;
    }

    interface Emits {
        (e: 'update', data: Partial<Model>): void;
        (e: 'delete'): void;
        (e: 'set-default'): void;
        (e: 'edit'): void;
    }

    const props = defineProps<Props>();
    const emit = defineEmits<Emits>();

    const alert = useAlert();
    const { confirm } = useConfirm();

    const handleDelete = async () => {
        if (props.isDefault) {
            alert.error('无法删除默认模型，请先设置其他模型为默认');
            return;
        }

        const confirmed = await confirm({
            title: '确认删除',
            message: `确定要删除模型 "${props.model.name}" 吗？`,
            type: 'danger',
            confirmText: '删除',
            cancelText: '取消',
        });

        if (confirmed) {
            emit('delete');
        }
    };
</script>

<template>
    <div class="rounded-lg border border-gray-200 bg-white p-4">
        <div class="flex items-center gap-3">
            <div class="relative">
                <input
                    type="radio"
                    name="default-model"
                    :checked="isDefault"
                    :disabled="!providerEnabled"
                    :class="[
                        'text-primary-500 mt-1 h-4 w-4',
                        !providerEnabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
                    ]"
                    :title="!providerEnabled ? '请先启用本服务商' : '设为默认模型'"
                    @change="emit('set-default')"
                />
            </div>

            <div :class="['relative', isDefault ? 'border-primary-500 rounded-full border-2' : '']">
                <ModelLogo :model-id="model.model_id" :name="model.name" />
            </div>

            <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-2">
                    <h4 class="font-serif text-sm font-medium text-gray-900">{{ model.name }}</h4>

                    <ModelCapabilityTags :model="model" />
                </div>

                <p v-if="model.last_used_at" class="mt-1 text-xs text-gray-400">
                    最后使用: {{ new Date(model.last_used_at as string).toLocaleString('zh-CN') }}
                </p>
            </div>

            <div class="flex gap-1">
                <button
                    class="flex h-7 w-7 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
                    title="编辑"
                    @click="emit('edit')"
                >
                    <AppIcon name="edit" class="h-4 w-4" />
                </button>
                <button
                    class="flex h-7 w-7 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
                    title="删除"
                    @click="handleDelete"
                >
                    <AppIcon name="delete" class="h-4 w-4" />
                </button>
            </div>
        </div>
    </div>
</template>
