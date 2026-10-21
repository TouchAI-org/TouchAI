<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    defineOptions({
        name: 'ModelFormDialog',
    });

    import DialogShell from '@components/DialogShell.vue';
    import { Badge } from '@components/ui/badge';
    import { Button } from '@components/ui/button';
    import { Input } from '@components/ui/input';
    import { useAlert } from '@composables/useAlert';
    import type { Model, NewModel } from '@database/schema';
    import { computed, ref, watch } from 'vue';

    import { t } from '@/i18n';
    import { parseModelModalities, supportsImageModality } from '@/utils/modelSchemas';

    import { CAPABILITY_CHIPS } from './capabilityChips';

    /*
     * 新增与编辑模型的表单原本是两个文件，模板部分逐字相同，
     * 差异只有四处，全部由 mode 决定：
     *
     *   1. 标题          新增 text-base font-bold / 编辑 text-[15px] font-medium
     *   2. 提交按钮文案   create / save
     *   3. 初始值         新增空表单 / 编辑从 model 反填
     *   4. 元数据语义     新增「用户自定义了任何能力」/ 编辑「相对原值有变化」
     *
     * 合并后模板只有一份，重复的 5 个能力 chip、2 个输入框和底部按钮
     * 不再需要在两处保持同步。
     */
    interface Props {
        /** create 时必填的是 providerId；edit 时必填的是 model */
        mode: 'create' | 'edit';
        providerId?: number;
        model?: Model;
        open?: boolean;
    }

    type Emits =
        | { (e: 'create', data: NewModel): void; (e: 'cancel'): void; (e: 'closed'): void }
        | { (e: 'update', data: Partial<Model>): void; (e: 'cancel'): void; (e: 'closed'): void };

    const props = withDefaults(defineProps<Props>(), {
        providerId: undefined,
        model: undefined,
        open: true,
    });

    const emit = defineEmits<Emits>();

    const alert = useAlert();

    interface ModelForm {
        name: string;
        model_id: string;
        reasoning: boolean;
        tool_call: boolean;
        attachment: boolean;
        open_weights: boolean;
        multimodal: boolean;
    }

    const emptyForm = (): ModelForm => ({
        name: '',
        model_id: '',
        reasoning: false,
        tool_call: false,
        attachment: false,
        open_weights: false,
        multimodal: false,
    });

    const formFromModel = (model: Model): ModelForm => {
        const form: ModelForm = {
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

    const buildForm = () =>
        props.mode === 'edit' && props.model ? formFromModel(props.model) : emptyForm();

    const form = ref<ModelForm>(buildForm());

    // 编辑态：模型身份变化时重新填充
    watch(
        () => props.model,
        (next) => {
            if (props.mode === 'edit' && next) {
                form.value = formFromModel(next);
            }
        }
    );
    // 每次真正打开时重置，避免上一次取消的编辑残留到下一次
    watch(
        () => props.open,
        (open, wasOpen) => {
            if (open && wasOpen === false) {
                form.value = buildForm();
            }
        }
    );

    const title = computed(() =>
        props.mode === 'create' ? t('settings.ai.addModelTitle') : t('settings.ai.editModel.title')
    );

    const titleClass = computed(() =>
        props.mode === 'create'
            ? 'mb-5 text-base font-bold text-neutral-950'
            : 'mb-5 text-[15px] font-medium text-neutral-950'
    );

    const submitLabel = computed(() =>
        props.mode === 'create' ? t('common.create') : t('common.save')
    );

    /** 新增态判断「用户是否自定义了任何能力」，编辑态判断「相对原值是否有变化」 */
    const metadataShouldPersist = () => {
        if (props.mode === 'create') {
            return (
                form.value.reasoning ||
                form.value.tool_call ||
                form.value.attachment ||
                form.value.open_weights ||
                form.value.multimodal
            );
        }
        const model = props.model;
        if (!model) {
            return false;
        }
        const originalMultimodal = supportsImageModality(parseModelModalities(model.modalities));
        return (
            form.value.reasoning !== (model.reasoning === 1) ||
            form.value.tool_call !== (model.tool_call === 1) ||
            form.value.attachment !== (model.attachment === 1) ||
            form.value.open_weights !== (model.open_weights === 1) ||
            form.value.multimodal !== originalMultimodal
        );
    };

    const handleSave = async () => {
        if (!form.value.name || !form.value.model_id) {
            alert.error(t('settings.ai.enterModelNameAndId'));
            return;
        }

        try {
            const persistMetadata = metadataShouldPersist();
            const modalities = {
                input: form.value.multimodal ? ['text', 'image'] : ['text'],
                output: ['text'],
            };

            if (props.mode === 'create') {
                const modelData: NewModel = {
                    provider_id: props.providerId as number,
                    name: form.value.name,
                    model_id: form.value.model_id,
                    is_default: 0,
                };
                if (persistMetadata) {
                    modelData.reasoning = form.value.reasoning ? 1 : 0;
                    modelData.tool_call = form.value.tool_call ? 1 : 0;
                    modelData.attachment = form.value.attachment ? 1 : 0;
                    modelData.open_weights = form.value.open_weights ? 1 : 0;
                    modelData.modalities = JSON.stringify(modalities);
                    modelData.is_custom_metadata = 1;
                }
                (emit as (e: 'create', data: NewModel) => void)('create', modelData);
                return;
            }

            const updateData: Partial<Model> = {
                name: form.value.name,
                model_id: form.value.model_id,
            };
            if (persistMetadata) {
                updateData.reasoning = form.value.reasoning ? 1 : 0;
                updateData.tool_call = form.value.tool_call ? 1 : 0;
                updateData.attachment = form.value.attachment ? 1 : 0;
                updateData.open_weights = form.value.open_weights ? 1 : 0;
                updateData.modalities = JSON.stringify(modalities);
                updateData.is_custom_metadata = 1;
            }
            (emit as (e: 'update', data: Partial<Model>) => void)('update', updateData);
        } catch (err) {
            const fallback =
                props.mode === 'create'
                    ? t('settings.ai.createFailed')
                    : t('settings.ai.saveFailed');
            alert.error(err instanceof Error ? err.message : fallback);
        }
    };
</script>

<template>
    <DialogShell :open="props.open" @closed="emit('closed')">
        <h2 :class="titleClass">{{ title }}</h2>

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
                {{ submitLabel }}
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
