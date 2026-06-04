<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import { computed } from 'vue';

    import { type MessageKey, t } from '@/i18n';

    import {
        type BrowserAutomationMode,
        type BrowserAutomationToolConfig,
        getBrowserAutomationStartupUrlError,
    } from '../types';

    interface Props {
        modelValue: BrowserAutomationToolConfig;
        disabled?: boolean;
    }

    interface Emits {
        (e: 'update:modelValue', value: BrowserAutomationToolConfig): void;
    }

    const props = defineProps<Props>();
    const emit = defineEmits<Emits>();

    const modeOptions: Array<{
        value: BrowserAutomationMode;
        titleKey: MessageKey;
        testId: string;
    }> = [
        {
            value: 'default',
            titleKey: 'settings.builtInTools.browser.mode.default',
            testId: 'browser-mode-default',
        },
        {
            value: 'custom',
            titleKey: 'settings.builtInTools.browser.mode.custom',
            testId: 'browser-mode-custom',
        },
    ];

    const startupUrlError = computed(() => getBrowserAutomationStartupUrlError(props.modelValue));

    function patch(next: Partial<BrowserAutomationToolConfig>) {
        emit('update:modelValue', {
            ...props.modelValue,
            ...next,
        });
    }
</script>

<template>
    <div class="space-y-5">
        <section class="space-y-4">
            <div class="flex items-center justify-between gap-4">
                <h4 class="text-sm font-semibold text-neutral-950">
                    {{ t('settings.builtInTools.browser.title') }}
                </h4>
            </div>

            <div class="grid gap-2 md:grid-cols-2">
                <button
                    v-for="option in modeOptions"
                    :key="option.value"
                    type="button"
                    :data-testid="option.testId"
                    :disabled="disabled"
                    :class="[
                        'rounded-lg border px-4 py-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                        modelValue.mode === option.value
                            ? 'border-transparent bg-[#e9e9e7]'
                            : 'border-transparent bg-transparent hover:bg-[#f1f1ef]',
                    ]"
                    @click="patch({ mode: option.value })"
                >
                    <p class="text-sm font-semibold text-neutral-950">
                        {{ t(option.titleKey) }}
                    </p>
                </button>
            </div>
        </section>

        <section v-if="modelValue.mode === 'custom'" class="space-y-4">
            <div>
                <label class="block text-sm font-medium text-neutral-700">
                    {{ t('settings.builtInTools.browser.browserId') }}
                </label>
                <input
                    :value="modelValue.browserId"
                    :disabled="disabled"
                    data-testid="browser-id"
                    type="text"
                    spellcheck="false"
                    class="settings-input mt-1.5 w-full font-mono disabled:bg-neutral-50"
                    :placeholder="t('settings.builtInTools.browser.browserIdPlaceholder')"
                    @input="patch({ browserId: ($event.target as HTMLInputElement).value })"
                />
            </div>
        </section>

        <section>
            <label class="block text-sm font-medium text-neutral-700">
                {{ t('settings.builtInTools.browser.startupUrl') }}
            </label>
            <input
                :value="modelValue.startupUrl"
                :disabled="disabled"
                data-testid="browser-startup-url"
                type="text"
                spellcheck="false"
                class="settings-input mt-1.5 w-full font-mono disabled:bg-neutral-50"
                :class="startupUrlError ? 'border-red-300 focus:border-red-500' : ''"
                :placeholder="t('settings.builtInTools.browser.startupUrlPlaceholder')"
                @input="patch({ startupUrl: ($event.target as HTMLInputElement).value })"
            />
            <p v-if="startupUrlError" class="mt-1.5 text-xs text-red-600">
                {{ startupUrlError }}
            </p>
        </section>
    </div>
</template>
