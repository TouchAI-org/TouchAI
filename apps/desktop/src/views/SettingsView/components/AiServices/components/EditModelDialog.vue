<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import DialogShell from '@components/DialogShell.vue';
    import { Badge } from '@components/ui/badge';
    import { Button } from '@components/ui/button';
    import { Input } from '@components/ui/input';
    import { useAlert } from '@composables/useAlert';
    import type { Model } from '@database/schema';
    import { ref, watch } from 'vue';

    import { t } from '@/i18n';
    import { parseModelModalities, supportsImageModality } from '@/utils/modelSchemas';

    import { CAPABILITY_CHIPS } from './capabilityChips';
    interface Props {
        model: Model;
        open?: boolean;
    }

    interface Emits {
        (e: 'update', data: Partial<Model>): void;
        (e: 'cancel'): void;
        (e: 'closed'): void;
    }

    const props = withDefaults(defineProps<Props>(), { open: true });
    const emit = defineEmits<Emits>();

    const alert = useAlert();

    const createForm = (model: Model) => {
        const form = {
            name: model.name,
            model_id: model.model_id,
            reasoning: model.reasoning === 1,
            tool_call: model.tool_call === 1,
            attachment: model.attachment === 1,
            open_weights: model.open_weights === 1,
            multimodal: false,
        };
        if (model.modalities) {
            form.multimodal = supportsImageModality(parseModelModalities(model.modalities));
        }
        return form;
    };

    const form = ref(createForm(props.model));

    // Refresh on identity changes and on every genuine opening so a cancelled
    // edit never survives into the next edit of the same model.
    watch(
        () => props.model,
        (newModel) => {
            form.value = createForm(newModel);
        }
    );
    watch(
        () => props.open,
        (open, wasOpen) => {
            if (open && wasOpen === false) form.value = createForm(props.model);
        }
    );

    const handleSave = async () => {
        if (!form.value.name || !form.value.model_id) {
            alert.error(t('settings.ai.enterModelNameAndId'));
            return;
        }

        try {
            // 检查用户是否修改了元数据
            const originalMultimodal = supportsImageModality(
                parseModelModalities(props.model.modalities)
            );

            const metadataChanged =
                form.value.reasoning !== (props.model.reasoning === 1) ||
                form.value.tool_call !== (props.model.tool_call === 1) ||
                form.value.attachment !== (props.model.attachment === 1) ||
                form.value.open_weights !== (props.model.open_weights === 1) ||
                form.value.multimodal !== originalMultimodal;

            // 构建 modalities JSON
            const modalities = {
                input: form.value.multimodal ? ['text', 'image'] : ['text'],
                output: ['text'],
            };

            const updateData: Partial<Model> = {
                name: form.value.name,
                model_id: form.value.model_id,
            };

            // 如果用户修改了元数据，则更新元数据字段并标记为自定义
            if (metadataChanged) {
                updateData.reasoning = form.value.reasoning ? 1 : 0;
                updateData.tool_call = form.value.tool_call ? 1 : 0;
                updateData.attachment = form.value.attachment ? 1 : 0;
                updateData.open_weights = form.value.open_weights ? 1 : 0;
                updateData.modalities = JSON.stringify(modalities);
                updateData.is_custom_metadata = 1;
            }

            emit('update', updateData);
        } catch (err) {
            alert.error(err instanceof Error ? err.message : t('settings.ai.saveFailed'));
        }
    };
</script>

<template>
    <DialogShell :open="props.open" @closed="emit('closed')">
        <h2 class="mb-5 text-[15px] font-medium text-neutral-950">
            {{ t('settings.ai.editModel.title') }}
        </h2>

        <div class="space-y-4">
            <div>
                <label class="block text-sm font-medium text-neutral-700">
                    {{ t('settings.ai.modelNameRequired') }}
                </label>
                <Input v-model="form.name" class="mt-1.5" placeholder="GPT-4o" />
                <p class="mt-1 text-xs text-neutral-400">{{ t('settings.ai.modelNameHelp') }}</p>
            </div>

            <div>
                <label class="block text-sm font-medium text-neutral-700">
                    {{ t('settings.ai.modelIdRequired') }}
                </label>
                <Input v-model="form.model_id" class="mt-1.5" placeholder="gpt-4o" />
                <p class="mt-1 text-xs text-neutral-400">{{ t('settings.ai.modelIdHelp') }}</p>
            </div>

            <div>
                <label class="mb-2 block text-sm font-medium text-neutral-700">
                    {{ t('settings.ai.modelCapabilities') }}
                </label>
                <div class="flex flex-wrap gap-2">
                    <Badge
                        v-for="cap in CAPABILITY_CHIPS"
                        :key="cap.key"
                        as="button"
                        variant="toggle"
                        :tone="cap.tone"
                        :active="Boolean(form[cap.key])"
                        @click="form[cap.key] = !form[cap.key]"
                    >
                        {{ t(cap.labelKey) }}
                    </Badge>
                </div>
            </div>
        </div>

        <div class="mt-6 flex gap-3">
            <Button
                class="bg-primary-700 hover:bg-primary-600 flex-1 rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors"
                @click="handleSave"
            >
                {{ t('common.save') }}
            </Button>
            <Button
                variant="outline"
                class="flex-1 rounded-lg border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-600 transition-colors hover:border-neutral-300"
                @click="emit('cancel')"
            >
                {{ t('common.cancel') }}
            </Button>
        </div>
    </DialogShell>
</template>
