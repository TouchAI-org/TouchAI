<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import { open } from '@tauri-apps/plugin-dialog';

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

    async function pickDirectory(defaultPath?: string): Promise<string | null> {
        try {
            const picked = await open({
                directory: true,
                multiple: false,
                defaultPath: defaultPath?.trim() || undefined,
                title: '选择目录',
            });
            return typeof picked === 'string' ? picked : null;
        } catch (error) {
            console.error('[BashToolConfig] Failed to pick directory:', error);
            return null;
        }
    }

    function normalizeDirectoryList(directories: string[]): string[] {
        return directories
            .map((value) => value.trim())
            .filter((value, index, items) => value.length > 0 && items.indexOf(value) === index);
    }

    async function addAllowedWorkingDirectory() {
        const selected = await pickDirectory(props.modelValue.defaultWorkingDirectory);
        if (!selected) {
            return;
        }

        patch({
            allowedWorkingDirectories: normalizeDirectoryList([
                ...props.modelValue.allowedWorkingDirectories,
                selected,
            ]),
        });
    }

    function removeAllowedWorkingDirectory(index: number) {
        const next = [...props.modelValue.allowedWorkingDirectories];
        next.splice(index, 1);
        patch({
            allowedWorkingDirectories: normalizeDirectoryList(next),
        });
    }

    async function pickDefaultWorkingDirectory() {
        const selected = await pickDirectory(props.modelValue.defaultWorkingDirectory);
        if (!selected) {
            return;
        }
        patch({ defaultWorkingDirectory: selected });
    }

    async function pickAllowedWorkingDirectory(index: number) {
        const selected = await pickDirectory(
            props.modelValue.allowedWorkingDirectories[index] ||
                props.modelValue.defaultWorkingDirectory
        );
        if (!selected) {
            return;
        }
        const next = [...props.modelValue.allowedWorkingDirectories];
        next[index] = selected;
        patch({
            allowedWorkingDirectories: normalizeDirectoryList(next),
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

            <div class="mt-5 space-y-4">
                <div>
                    <label class="block font-serif text-sm font-medium text-gray-600">
                        默认工作目录
                    </label>
                    <div class="mt-1.5 flex gap-2">
                        <input
                            :value="modelValue.defaultWorkingDirectory"
                            :disabled="disabled"
                            readonly
                            type="text"
                            spellcheck="false"
                            class="focus:border-primary-400 flex-1 rounded-lg border border-gray-200 px-3 py-2 font-mono text-sm text-gray-900 transition-colors focus:outline-none disabled:bg-gray-50"
                            placeholder="未设置时运行时默认桌面"
                        />
                        <button
                            type="button"
                            :disabled="disabled"
                            class="text-gray-400 transition-colors hover:text-gray-600 disabled:cursor-not-allowed disabled:opacity-60"
                            title="选择目录"
                            aria-label="选择目录"
                            @click="pickDefaultWorkingDirectory"
                        >
                            <AppIcon name="folder-open" class="h-5 w-5" />
                        </button>
                    </div>
                </div>

                <div>
                    <div class="flex items-center justify-between">
                        <label class="block font-serif text-sm font-medium text-gray-600">
                            允许工作目录
                        </label>
                        <button
                            type="button"
                            :disabled="disabled"
                            class="text-gray-400 transition-colors hover:text-gray-600 disabled:cursor-not-allowed disabled:opacity-60"
                            @click="addAllowedWorkingDirectory"
                        >
                            <AppIcon name="plus" class="h-5 w-5" />
                        </button>
                    </div>

                    <div
                        v-if="modelValue.allowedWorkingDirectories.length > 0"
                        class="mt-2 space-y-2"
                    >
                        <div
                            v-for="(directory, index) in modelValue.allowedWorkingDirectories"
                            :key="index"
                            class="flex gap-2"
                        >
                            <input
                                :value="directory"
                                :disabled="disabled"
                                readonly
                                type="text"
                                spellcheck="false"
                                class="focus:border-primary-400 flex-1 rounded-lg border border-gray-200 px-4 py-2.5 font-mono text-sm text-gray-900 transition-colors focus:outline-none disabled:bg-gray-50"
                                placeholder="D:\\Project\\TouchAI"
                            />
                            <button
                                type="button"
                                :disabled="disabled"
                                class="text-gray-400 transition-colors hover:text-gray-600 disabled:cursor-not-allowed disabled:opacity-60"
                                title="选择目录"
                                aria-label="选择目录"
                                @click="pickAllowedWorkingDirectory(index)"
                            >
                                <AppIcon name="folder-open" class="h-5 w-5" />
                            </button>
                            <button
                                type="button"
                                :disabled="disabled"
                                class="text-gray-400 transition-colors hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-60"
                                @click="removeAllowedWorkingDirectory(index)"
                            >
                                <AppIcon name="x" class="h-5 w-5" />
                            </button>
                        </div>
                    </div>
                    <div
                        v-else
                        class="mt-2 rounded-xl border border-dashed border-gray-200 bg-gray-50/60 px-4 py-3 font-serif text-sm text-gray-500"
                    >
                        未设置时运行时允许全部路径
                    </div>
                </div>

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
