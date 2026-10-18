<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import ModelCapabilityTags from '@components/ModelCapabilityTags.vue';
    import ModelLogo from '@components/ModelLogo.vue';
    import { useAlert } from '@composables/useAlert';
    import { useConfirm } from '@composables/useConfirm';
    import type { Model } from '@database/schema';

    import { t } from '@/i18n';

    import ModelCardActions from './ModelCardActions.vue';
    interface Props {
        model: Model;
        isDefault: boolean;
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
    <div class="settings-card group/model">
        <div class="flex items-center gap-5">
            <div class="relative shrink-0">
                <ModelLogo :model-id="model.model_id" :name="model.name" />
                <span
                    v-if="isDefault"
                    data-testid="default-model-badge"
                    class="absolute top-0 right-0 min-w-max translate-x-1/2 -translate-y-1/2 rounded border border-neutral-300 bg-white px-1 py-0.5 text-[9px] leading-none whitespace-nowrap text-neutral-600 shadow-sm"
                >
                    {{ t('common.default') }}
                </span>
            </div>

            <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-2">
                    <h4
                        class="min-w-0 text-sm font-medium wrap-anywhere text-neutral-950"
                        data-no-i18n="true"
                        translate="no"
                    >
                        {{ model.name }}
                    </h4>

                    <ModelCapabilityTags :model="model" />
                </div>
            </div>

            <ModelCardActions
                :is-default="isDefault"
                @set-default="emit('set-default')"
                @edit="emit('edit')"
                @delete="handleDelete"
            />
        </div>
    </div>
</template>
