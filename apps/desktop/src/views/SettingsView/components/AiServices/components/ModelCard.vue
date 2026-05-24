<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import ModelCapabilityTags from '@components/ModelCapabilityTags.vue';
    import ModelLogo from '@components/ModelLogo.vue';
    import { useAlert } from '@composables/useAlert';
    import { useConfirm } from '@composables/useConfirm';
    import type { Model } from '@database/schema';


    import { t } from '@/i18n';
    import { formatDateTime } from '@/i18n/format';
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
            alert.error(t('settings.ai.cannotDeleteDefaultModel'));
            return;
        }

        const confirmed = await confirm({
            title: t('settings.ai.confirmDeleteTitle'),
            message: t('settings.ai.confirmDeleteModel', { modelName: props.model.name }),
            type: 'danger',
            confirmText: t('common.delete'),
            cancelText: t('common.cancel'),
        });

        if (confirmed) {
            emit('delete');
        }
    };
</script>

<template>
    <div class="rounded-lg border border-neutral-200 bg-white p-4">
        <div class="flex items-center gap-3">
            <div class="relative">
                <input
                    type="radio"
                    name="default-model"
                    :checked="isDefault"
                    :disabled="!providerEnabled"
                    :class="[
                        'mt-1 h-4 w-4 text-neutral-950',
                        !providerEnabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
                    ]"
                    :title="!providerEnabled ? t('settings.ai.enableProviderFirst') : t('settings.ai.setDefaultModel')"
                    @change="emit('set-default')"
                />
            </div>

            <div :class="['relative', isDefault ? 'rounded-full border-2 border-neutral-950' : '']">
                <ModelLogo :model-id="model.model_id" :name="model.name" />
            </div>

            <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-2">
                    <h4
                        class="text-sm font-medium text-neutral-950"
                        data-no-i18n="true"
                        translate="no"
                    >
                        {{ model.name }}
                    </h4>

                    <ModelCapabilityTags :model="model" />
                </div>

                <p v-if="model.last_used_at" class="mt-1 text-xs text-neutral-400">
                    {{ t('settings.ai.lastUsed') }}
                    {{ formatDateTime(model.last_used_at as string) }}
                </p>
            </div>

            <div class="flex gap-1">
                <button
                    class="settings-icon-button h-7 w-7 rounded-md"
                    :title="t('common.edit')"
                    @click="emit('edit')"
                >
                    <AppIcon name="edit" class="h-4 w-4" />
                </button>
                <button
                    class="settings-icon-button h-7 w-7 rounded-md"
                    :title="t('common.delete')"
                    @click="handleDelete"
                >
                    <AppIcon name="delete" class="h-4 w-4" />
                </button>
            </div>
        </div>
    </div>
</template>
