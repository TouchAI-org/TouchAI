<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import DialogShell from '@components/DialogShell.vue';
    import { Badge } from '@components/ui/badge';
    import { Button } from '@components/ui/button';
    import { Input } from '@components/ui/input';
    import { useAlert } from '@composables/useAlert';
    import type { NewModel } from '@database/schema';
    import { ref, watch } from 'vue';

    import { t } from '@/i18n';

    import { CAPABILITY_CHIPS } from './capabilityChips';
    interface Props {
        providerId: number;
        open?: boolean;
    }

    interface Emits {
        (e: 'create', data: NewModel): void;
        (e: 'cancel'): void;
        (e: 'closed'): void;
    }

    const props = withDefaults(defineProps<Props>(), { open: true });
    const emit = defineEmits<Emits>();

    const alert = useAlert();

    const createInitialForm = () => ({
        name: '',
        model_id: '',
        reasoning: false,
        tool_call: false,
        attachment: false,
        open_weights: false,
        multimodal: false,
    });
    const form = ref(createInitialForm());

    const resetForm = () => {
        form.value = createInitialForm();
    };

    watch(
        () => props.open,
        (open, wasOpen) => {
            if (open && wasOpen === false) resetForm();
        }
    );

    const handleSave = async () => {
        if (!form.value.name || !form.value.model_id) {
            alert.error(t('settings.ai.enterModelNameAndId'));
            return;
        }

        try {
            // 检查用户是否自定义了元数据（任何一个能力被勾选）
            const hasCustomMetadata =
                form.value.reasoning ||
                form.value.tool_call ||
                form.value.attachment ||
                form.value.open_weights ||
                form.value.multimodal;

            // 构建 modalities JSON
            const modalities = {
                input: form.value.multimodal ? ['text', 'image'] : ['text'],
                output: ['text'],
            };

            // 创建模型
            const modelData: NewModel = {
                provider_id: props.providerId,
                name: form.value.name,
                model_id: form.value.model_id,
                is_default: 0,
            };

            // 只有用户自定义了元数据时才设置这些字段
            if (hasCustomMetadata) {
                modelData.reasoning = form.value.reasoning ? 1 : 0;
                modelData.tool_call = form.value.tool_call ? 1 : 0;
                modelData.attachment = form.value.attachment ? 1 : 0;
                modelData.open_weights = form.value.open_weights ? 1 : 0;
                modelData.modalities = JSON.stringify(modalities);
                modelData.is_custom_metadata = 1;
            }

            emit('create', modelData);
        } catch (err) {
            alert.error(err instanceof Error ? err.message : t('settings.ai.createFailed'));
        }
    };
</script>

<template>
    <DialogShell :open="props.open" @closed="emit('closed')">
        <h2 class="mb-5 text-base font-bold text-neutral-950">
            {{ t('settings.ai.addModelTitle') }}
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
                {{ t('common.create') }}
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
