<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import { t } from '@/i18n';

    import type { DesktopContextToolConfig } from '../types';
    interface Props {
        modelValue: DesktopContextToolConfig;
        disabled?: boolean;
    }

    interface Emits {
        (e: 'update:modelValue', value: DesktopContextToolConfig): void;
    }

    const props = defineProps<Props>();
    const emit = defineEmits<Emits>();

    function patch(next: Partial<DesktopContextToolConfig>) {
        emit('update:modelValue', {
            ...props.modelValue,
            ...next,
        });
    }

    interface ToggleItem {
        key: keyof DesktopContextToolConfig;
        title: string;
        description: string;
    }

    const toggles: ToggleItem[] = [
        {
            key: 'captureSelectedText',
            title: t('settings.builtInTools.desktopContext.captureSelectedText'),
            description: t('settings.builtInTools.desktopContext.captureSelectedTextDescription'),
        },
        {
            key: 'autoInjectSelectedText',
            title: t('settings.builtInTools.desktopContext.autoInjectSelectedText'),
            description: t('settings.builtInTools.desktopContext.autoInjectSelectedTextDescription'),
        },
        {
            key: 'captureBrowserUrl',
            title: t('settings.builtInTools.desktopContext.captureBrowserUrl'),
            description: t('settings.builtInTools.desktopContext.captureBrowserUrlDescription'),
        },
        {
            key: 'enableScreenshotOcr',
            title: t('settings.builtInTools.desktopContext.enableScreenshotOcr'),
            description: t('settings.builtInTools.desktopContext.enableScreenshotOcrDescription'),
        },
    ];
</script>

<template>
    <div class="settings-page-wide space-y-4">
        <div class="space-y-5">
            <div v-for="item in toggles" :key="item.key">
                <label class="block font-serif text-sm font-medium text-gray-600">
                    {{ item.title }}
                </label>
                <p class="mt-0.5 font-serif text-xs text-gray-400">
                    {{ item.description }}
                </p>
                <label class="relative mt-1.5 inline-flex shrink-0 cursor-pointer items-center">
                    <input
                        type="checkbox"
                        :checked="modelValue[item.key]"
                        :disabled="disabled"
                        class="peer sr-only"
                        @change="patch({ [item.key]: !modelValue[item.key] })"
                    />
                    <div
                        class="peer h-5 w-9 rounded-full transition-colors"
                        :class="{
                            'bg-primary-500': modelValue[item.key],
                            'bg-gray-200': !modelValue[item.key],
                            'cursor-not-allowed opacity-50': disabled,
                        }"
                    >
                        <div
                            class="absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform"
                            :class="{
                                'translate-x-4': modelValue[item.key],
                                'translate-x-0': !modelValue[item.key],
                            }"
                        ></div>
                    </div>
                </label>
            </div>
        </div>
    </div>
</template>
