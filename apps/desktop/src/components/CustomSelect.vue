<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts" generic="T extends string | number">
    import {
        Select,
        SelectContent,
        SelectItem,
        SelectTrigger,
        SelectValue,
    } from '@components/ui/select';
    import type { AcceptableValue } from 'reka-ui';
    import { computed, ref } from 'vue';

    interface Option {
        label: string;
        value: T;
        description?: string;
        iconSrc?: string;
    }

    interface Props {
        modelValue: T;
        options: Option[];
        placeholder?: string;
        disabled?: boolean;
    }

    interface Emits {
        (e: 'update:modelValue', value: T): void;
    }

    const props = withDefaults(defineProps<Props>(), {
        placeholder: '请选择',
        disabled: false,
    });

    const emit = defineEmits<Emits>();

    const isOpen = ref(false);

    const selectedOption = computed(() => {
        return props.options.find((opt) => opt.value === props.modelValue);
    });

    const selectOption = (value: T) => {
        emit('update:modelValue', value);
    };

    const handleSelectValue = (value: AcceptableValue) => {
        if (typeof value === 'string' || typeof value === 'number') {
            selectOption(value as T);
        }
    };
</script>

<template>
    <Select
        :model-value="modelValue"
        :disabled="disabled"
        :open="isOpen"
        @update:model-value="handleSelectValue"
        @update:open="isOpen = $event"
    >
        <SelectTrigger
            class="w-full rounded-lg border px-3 py-2 text-left font-serif text-sm transition-colors"
            :class="{
                'border-gray-200 bg-white text-gray-900 hover:border-gray-300': !disabled,
                'cursor-not-allowed border-gray-100 bg-gray-50 text-gray-400': disabled,
                'border-primary-400': isOpen,
            }"
            :icon-class="isOpen ? 'rotate-180' : ''"
            :disabled="disabled"
        >
            <template v-if="selectedOption">
                <div class="flex min-w-0 items-center gap-2">
                    <img
                        v-if="selectedOption.iconSrc"
                        :src="selectedOption.iconSrc"
                        :alt="selectedOption.label"
                        class="h-4 w-4 shrink-0 rounded-sm object-contain"
                    />
                    <span class="line-clamp-1">{{ selectedOption.label }}</span>
                </div>
            </template>
            <SelectValue v-else :placeholder="placeholder" />
        </SelectTrigger>

        <SelectContent
            class="w-[var(--reka-select-trigger-width)] rounded-lg border border-gray-200 bg-white py-1 shadow-lg"
        >
            <SelectItem
                v-for="option in options"
                :key="option.value"
                :value="option.value"
                class="flex w-full px-3 py-2 text-left text-sm transition-colors hover:bg-gray-100"
                :class="{
                    'bg-primary-50 text-primary-600': option.value === modelValue,
                    'text-gray-900': option.value !== modelValue,
                }"
            >
                <div class="flex min-w-0 items-center gap-2">
                    <img
                        v-if="option.iconSrc"
                        :src="option.iconSrc"
                        :alt="option.label"
                        class="h-4 w-4 shrink-0 rounded-sm object-contain"
                    />
                    <div class="min-w-0">
                        <span class="block font-serif font-medium">{{ option.label }}</span>
                        <span v-if="option.description" class="mt-0.5 block text-xs text-gray-400">
                            {{ option.description }}
                        </span>
                    </div>
                </div>
            </SelectItem>
        </SelectContent>
    </Select>
</template>
