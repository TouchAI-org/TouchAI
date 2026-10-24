<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import { Input } from '@components/ui/input';
    import { Switch } from '@components/ui/switch';
    import { open } from '@tauri-apps/plugin-dialog';

    import { t } from '@/i18n';

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
            title: t('settings.builtInTools.bash.approvalMode.auto'),
        },
        {
            value: 'always',
            title: t('settings.builtInTools.bash.approvalMode.askEachTime'),
        },
        {
            value: 'never',
            title: t('settings.builtInTools.bash.approvalMode.fullAccess'),
        },
    ];

    function patch(next: Partial<BashToolConfig>) {
        emit('update:modelValue', {
            ...props.modelValue,
            ...next,
        });
    }

    /**
     * 写入超时上限。
     *
     * 输入框被清空时保持原值：0 在配置里表示“不设超时”，
     * 不能因为删空输入框就意外关闭超时保护。
     */
    function updateTimeoutMs(event: Event) {
        const raw = (event.target as HTMLInputElement).value;
        if (raw === '') {
            return;
        }

        patch({ timeoutMs: Number(raw) });
    }

    async function pickDirectory(defaultPath?: string): Promise<string | null> {
        try {
            const picked = await open({
                directory: true,
                multiple: false,
                defaultPath: defaultPath?.trim() || undefined,
                title: t('settings.builtInTools.bash.chooseDirectory'),
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
        <div class="space-y-5">
            <div class="flex items-start justify-between gap-4">
                <div>
                    <h4 class="text-sm font-semibold text-neutral-950">
                        {{ t('settings.builtInTools.bash.executionAndApproval') }}
                    </h4>
                </div>
            </div>

            <div class="mt-4 grid gap-3 md:grid-cols-3">
                <button
                    v-for="option in approvalModeOptions"
                    :key="option.value"
                    type="button"
                    :disabled="disabled"
                    :class="[
                        'rounded-lg border px-4 py-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                        modelValue.approvalMode === option.value
                            ? 'border-transparent bg-surface-selected shadow-none'
                            : 'border-transparent bg-transparent hover:bg-surface-hover',
                    ]"
                    @click="patch({ approvalMode: option.value })"
                >
                    <p class="text-sm font-semibold text-neutral-950">
                        {{ option.title }}
                    </p>
                </button>
            </div>

            <div class="mt-5 space-y-4">
                <div>
                    <label class="block text-sm font-medium text-neutral-700">
                        {{ t('settings.builtInTools.bash.defaultWorkingDirectory') }}
                    </label>
                    <div class="mt-1.5 flex gap-2">
                        <Input
                            variant="filled"
                            :model-value="modelValue.defaultWorkingDirectory"
                            :disabled="disabled"
                            readonly
                            type="text"
                            spellcheck="false"
                            class="flex-1 font-mono disabled:bg-neutral-50"
                            :placeholder="
                                t('settings.builtInTools.bash.defaultWorkingDirectoryPlaceholder')
                            "
                        />
                        <button
                            type="button"
                            :disabled="disabled"
                            class="text-neutral-400 transition-colors hover:text-neutral-700 disabled:cursor-not-allowed disabled:opacity-60"
                            :title="t('settings.builtInTools.bash.chooseDirectory')"
                            :aria-label="t('settings.builtInTools.bash.chooseDirectory')"
                            @click="pickDefaultWorkingDirectory"
                        >
                            <AppIcon name="folder-open" class="h-5 w-5" />
                        </button>
                    </div>
                </div>

                <div>
                    <div class="flex items-center justify-between">
                        <label class="block text-sm font-medium text-neutral-700">
                            {{ t('settings.builtInTools.bash.allowedWorkingDirectories') }}
                        </label>
                        <button
                            type="button"
                            :disabled="disabled"
                            class="text-neutral-400 transition-colors hover:text-neutral-700 disabled:cursor-not-allowed disabled:opacity-60"
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
                            <Input
                                variant="filled"
                                :model-value="directory"
                                :disabled="disabled"
                                readonly
                                type="text"
                                spellcheck="false"
                                class="flex-1 px-4 py-2.5 font-mono disabled:bg-neutral-50"
                                placeholder="D:\\Project\\TouchAI"
                            />
                            <button
                                type="button"
                                :disabled="disabled"
                                class="text-neutral-400 transition-colors hover:text-neutral-700 disabled:cursor-not-allowed disabled:opacity-60"
                                :title="t('settings.builtInTools.bash.chooseDirectory')"
                                :aria-label="t('settings.builtInTools.bash.chooseDirectory')"
                                @click="pickAllowedWorkingDirectory(index)"
                            >
                                <AppIcon name="folder-open" class="h-5 w-5" />
                            </button>
                            <button
                                type="button"
                                :disabled="disabled"
                                class="text-neutral-400 transition-colors hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-60"
                                @click="removeAllowedWorkingDirectory(index)"
                            >
                                <AppIcon name="x" class="h-5 w-5" />
                            </button>
                        </div>
                    </div>
                    <div
                        v-else
                        class="mt-2 rounded-lg border border-dashed border-neutral-200 bg-neutral-50/60 px-4 py-3 text-sm text-neutral-500"
                    >
                        {{ t('settings.builtInTools.bash.allowAllDirectoriesWhenEmpty') }}
                    </div>
                </div>

                <div>
                    <label class="block text-sm font-medium text-neutral-700">
                        {{ t('settings.builtInTools.bash.timeoutMs') }}
                    </label>
                    <Input
                        variant="filled"
                        :model-value="modelValue.timeoutMs"
                        :disabled="disabled"
                        type="number"
                        min="0"
                        max="120000"
                        class="mt-1.5 w-full disabled:bg-neutral-50"
                        @input="updateTimeoutMs"
                    />
                    <p class="mt-1 text-xs text-neutral-500">
                        {{ t('settings.builtInTools.bash.timeoutMsHint') }}
                    </p>
                </div>

                <div>
                    <label class="block text-sm font-medium text-neutral-700">
                        {{ t('settings.builtInTools.bash.outputLimitChars') }}
                    </label>
                    <Input
                        variant="filled"
                        :model-value="modelValue.maxOutputChars"
                        :disabled="disabled"
                        type="number"
                        min="1000"
                        max="50000"
                        class="mt-1.5 w-full disabled:bg-neutral-50"
                        @input="
                            patch({
                                maxOutputChars: Number(
                                    ($event.target as HTMLInputElement).value || 0
                                ),
                            })
                        "
                    />
                </div>

                <div>
                    <label class="block font-serif text-sm font-medium text-gray-600">
                        {{ t('settings.builtInTools.bash.compactOutput') }}
                    </label>
                    <p class="mt-0.5 font-serif text-xs text-gray-400">
                        {{ t('settings.builtInTools.bash.compactOutputDescription') }}
                    </p>
                    <Switch
                        size="md"
                        tone="subtle"
                        class="mt-1.5"
                        :model-value="modelValue.compactOutput"
                        :disabled="disabled"
                        @update:model-value="patch({ compactOutput: !modelValue.compactOutput })"
                    />
                </div>
            </div>
        </div>
    </div>
</template>
