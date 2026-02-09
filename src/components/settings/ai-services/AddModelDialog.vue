<!-- Copyright (c) 2025. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import { useAlert } from '@composables/useAlert';
    import { upsertLlmMetadata } from '@database/queries';
    import type { NewModel } from '@database/schema';
    import { ref } from 'vue';

    interface Props {
        providerId: number;
    }

    interface Emits {
        (e: 'create', data: NewModel): void;
        (e: 'cancel'): void;
    }

    const props = defineProps<Props>();
    const emit = defineEmits<Emits>();

    const alert = useAlert();

    const form = ref({
        name: '',
        model_id: '',
        reasoning: false,
        tool_call: false,
        attachment: false,
        open_weights: false,
        multimodal: false,
    });

    const handleSave = async () => {
        if (!form.value.name || !form.value.model_id) {
            alert.error('请填写模型名称和模型 ID');
            return;
        }

        try {
            // 构建 modalities JSON
            const modalities = {
                input: form.value.multimodal ? ['text', 'image'] : ['text'],
                output: ['text'],
            };

            // 创建元数据
            await upsertLlmMetadata(form.value.model_id, {
                name: form.value.name,
                reasoning: form.value.reasoning ? 1 : 0,
                tool_call: form.value.tool_call ? 1 : 0,
                attachment: form.value.attachment ? 1 : 0,
                open_weights: form.value.open_weights ? 1 : 0,
                modalities: JSON.stringify(modalities),
            });

            // 创建模型
            emit('create', {
                provider_id: props.providerId,
                name: form.value.name,
                model_id: form.value.model_id,
                is_default: 0,
            });
        } catch (err) {
            alert.error(err instanceof Error ? err.message : '创建失败');
        }
    };
</script>

<template>
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
        <div class="w-full max-w-md rounded-xl border border-gray-200 bg-white p-6 shadow-xl">
            <h2 class="mb-5 font-serif text-base font-bold text-gray-900">添加模型</h2>

            <div class="space-y-4">
                <div>
                    <label class="block font-serif text-sm font-medium text-gray-600">
                        模型名称 *
                    </label>
                    <input
                        v-model="form.name"
                        type="text"
                        class="focus:border-primary-400 mt-1.5 w-full rounded-lg border border-gray-200 px-3 py-2 font-serif text-sm text-gray-900 transition-colors focus:outline-none"
                        placeholder="GPT-4o"
                    />
                    <p class="mt-1 text-xs text-gray-400">用于显示的模型名称</p>
                </div>

                <div>
                    <label class="block font-serif text-sm font-medium text-gray-600">
                        模型 ID *
                    </label>
                    <input
                        v-model="form.model_id"
                        type="text"
                        class="focus:border-primary-400 mt-1.5 w-full rounded-lg border border-gray-200 px-3 py-2 font-serif text-sm text-gray-900 transition-colors focus:outline-none"
                        placeholder="gpt-4o"
                    />
                    <p class="mt-1 text-xs text-gray-400">API 调用时使用的模型标识符</p>
                </div>

                <div>
                    <label class="mb-2 block font-serif text-sm font-medium text-gray-600">
                        模型能力
                    </label>
                    <div class="flex flex-wrap gap-2">
                        <button
                            type="button"
                            :class="[
                                'rounded px-1.5 py-0.5 text-xs font-medium transition-colors',
                                form.reasoning
                                    ? 'bg-blue-50 text-blue-600 hover:bg-blue-100'
                                    : 'bg-gray-100 text-gray-400 hover:bg-gray-200',
                            ]"
                            @click="form.reasoning = !form.reasoning"
                        >
                            推理
                        </button>
                        <button
                            type="button"
                            :class="[
                                'rounded px-1.5 py-0.5 text-xs font-medium transition-colors',
                                form.tool_call
                                    ? 'bg-green-50 text-green-600 hover:bg-green-100'
                                    : 'bg-gray-100 text-gray-400 hover:bg-gray-200',
                            ]"
                            @click="form.tool_call = !form.tool_call"
                        >
                            工具
                        </button>
                        <button
                            type="button"
                            :class="[
                                'rounded px-1.5 py-0.5 text-xs font-medium transition-colors',
                                form.multimodal
                                    ? 'bg-purple-50 text-purple-600 hover:bg-purple-100'
                                    : 'bg-gray-100 text-gray-400 hover:bg-gray-200',
                            ]"
                            @click="form.multimodal = !form.multimodal"
                        >
                            多模态
                        </button>
                        <button
                            type="button"
                            :class="[
                                'rounded px-1.5 py-0.5 text-xs font-medium transition-colors',
                                form.attachment
                                    ? 'bg-orange-50 text-orange-600 hover:bg-orange-100'
                                    : 'bg-gray-100 text-gray-400 hover:bg-gray-200',
                            ]"
                            @click="form.attachment = !form.attachment"
                        >
                            文件
                        </button>
                        <button
                            type="button"
                            :class="[
                                'rounded px-1.5 py-0.5 text-xs font-medium transition-colors',
                                form.open_weights
                                    ? 'bg-indigo-50 text-indigo-600 hover:bg-indigo-100'
                                    : 'bg-gray-100 text-gray-400 hover:bg-gray-200',
                            ]"
                            @click="form.open_weights = !form.open_weights"
                        >
                            开源
                        </button>
                    </div>
                </div>
            </div>

            <div class="mt-6 flex gap-3">
                <button
                    class="bg-primary-500 hover:bg-primary-600 flex-1 rounded-lg px-4 py-2 font-serif text-sm font-medium text-white transition-colors"
                    @click="handleSave"
                >
                    创建
                </button>
                <button
                    class="flex-1 rounded-lg border border-gray-200 px-4 py-2 font-serif text-sm font-medium text-gray-600 transition-colors hover:border-gray-300"
                    @click="emit('cancel')"
                >
                    取消
                </button>
            </div>
        </div>
    </div>
</template>
