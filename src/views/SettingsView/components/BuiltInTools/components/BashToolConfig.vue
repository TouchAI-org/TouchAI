<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import type { BashApprovalMode, BashToolConfig } from '../types';

    interface Props {
        modelValue: BashToolConfig;
        disabled?: boolean;
    }

    interface Emits {
        (e: 'update:modelValue', value: BashToolConfig): void;
    }

    const props = defineProps<Props>();
    const emit = defineEmits<Emits>();

    const approvalModeOptions: Array<{
        value: BashApprovalMode;
        title: string;
    }> = [
        {
            value: 'high_risk',
            title: '自动',
        },
        {
            value: 'always',
            title: '每次询问',
        },
        {
            value: 'never',
            title: '完全访问',
        },
    ];

    function patch(next: Partial<BashToolConfig>) {
        emit('update:modelValue', {
            ...props.modelValue,
            ...next,
        });
    }
</script>

<template>
    <div class="space-y-5">
        <section class="rounded-xl border border-gray-200 bg-white p-5">
            <div class="flex items-start justify-between gap-4">
                <div>
                    <h4 class="font-serif text-sm font-semibold text-gray-900">执行与审批</h4>
                </div>
            </div>

            <div class="mt-4 grid gap-3 md:grid-cols-3">
                <button
                    v-for="option in approvalModeOptions"
                    :key="option.value"
                    type="button"
                    :disabled="disabled"
                    :class="[
                        'rounded-xl border px-4 py-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                        modelValue.approvalMode === option.value
                            ? 'border-primary-300 bg-primary-50'
                            : 'border-gray-200 bg-gray-50/70 hover:border-gray-300 hover:bg-white',
                    ]"
                    @click="patch({ approvalMode: option.value })"
                >
                    <p class="font-serif text-sm font-semibold text-gray-900">
                        {{ option.title }}
                    </p>
                </button>
            </div>

            <div class="mt-5 grid gap-4 md:grid-cols-2">
                <div>
                    <label class="block font-serif text-sm font-medium text-gray-600">
                        超时上限（毫秒）
                    </label>
                    <input
                        :value="modelValue.timeoutMs"
                        :disabled="disabled"
                        type="number"
                        min="1000"
                        max="120000"
                        class="focus:border-primary-400 mt-1.5 w-full rounded-lg border border-gray-200 px-3 py-2 font-serif text-sm text-gray-900 transition-colors focus:outline-none disabled:bg-gray-50"
                        @input="
                            patch({
                                timeoutMs: Number(($event.target as HTMLInputElement).value || 0),
                            })
                        "
                    />
                </div>

                <div>
                    <label class="block font-serif text-sm font-medium text-gray-600">
                        输出上限（字符）
                    </label>
                    <input
                        :value="modelValue.maxOutputChars"
                        :disabled="disabled"
                        type="number"
                        min="1000"
                        max="50000"
                        class="focus:border-primary-400 mt-1.5 w-full rounded-lg border border-gray-200 px-3 py-2 font-serif text-sm text-gray-900 transition-colors focus:outline-none disabled:bg-gray-50"
                        @input="
                            patch({
                                maxOutputChars: Number(
                                    ($event.target as HTMLInputElement).value || 0
                                ),
                            })
                        "
                    />
                </div>
            </div>
        </section>
    </div>
</template>
