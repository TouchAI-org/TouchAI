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
        multiSelectMode?: boolean;
        isSelected?: boolean;
        area?: 'support' | 'selection';
    }

    interface Emits {
        (e: 'update', data: Partial<Model>): void;
        (e: 'delete'): void;
        (e: 'set-default'): void;
        (e: 'edit'): void;
        (e: 'toggle-select'): void;
        (e: 'add-to-selection'): void;
        (e: 'remove-from-selection'): void;
    }

    const props = withDefaults(defineProps<Props>(), {
        multiSelectMode: false,
        isSelected: false,
        area: 'selection',
    });
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

    const handleCardClick = () => {
        if (props.multiSelectMode) {
            emit('toggle-select');
        }
    };
</script>

<template>
    <div
        class="rounded-lg border bg-white p-4 transition-colors"
        :class="[
            isSelected && multiSelectMode
                ? 'border-primary-400 bg-primary-50/30'
                : 'border-neutral-200',
        ]"
        @click="handleCardClick"
    >
        <div class="flex items-center gap-3">
            <div v-if="multiSelectMode" class="relative flex items-center">
                <input
                    type="checkbox"
                    :checked="isSelected"
                    class="text-primary-600 focus:ring-primary-500 h-4 w-4 rounded border-neutral-300"
                    @click.stop
                    @change="emit('toggle-select')"
                />
            </div>
            <div v-else class="relative">
                <input
                    type="radio"
                    name="default-model"
                    :checked="isDefault"
                    :disabled="!providerEnabled"
                    :class="[
                        'mt-1 h-4 w-4 text-neutral-950',
                        !providerEnabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
                    ]"
                    :title="
                        !providerEnabled
                            ? t('settings.ai.enableProviderFirst')
                            : t('settings.ai.setDefaultModel')
                    "
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

            <div v-if="!multiSelectMode" class="flex gap-1">
                <button
                    v-if="area === 'support'"
                    class="settings-icon-button h-7 w-7 rounded-md"
                    :title="t('settings.ai.addToSelection')"
                    @click.stop="emit('add-to-selection')"
                >
                    <AppIcon name="plus" class="h-4 w-4" />
                </button>
                <button
                    v-if="area === 'selection'"
                    class="settings-icon-button h-7 w-7 rounded-md"
                    :title="t('settings.ai.removeFromSelection')"
                    @click.stop="emit('remove-from-selection')"
                >
                    <AppIcon name="minimize" class="h-4 w-4" />
                </button>
                <button
                    class="settings-icon-button h-7 w-7 rounded-md"
                    :title="t('common.edit')"
                    @click.stop="emit('edit')"
                >
                    <AppIcon name="edit" class="h-4 w-4" />
                </button>
                <button
                    class="settings-icon-button h-7 w-7 rounded-md"
                    :title="t('common.delete')"
                    @click.stop="handleDelete"
                >
                    <AppIcon name="delete" class="h-4 w-4" />
                </button>
            </div>
        </div>
    </div>
</template>
