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
    import { computed, ref, useAttrs } from 'vue';

    import { type MessageKey, t, tt } from '@/i18n';

    defineOptions({ inheritAttrs: false });

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
        placeholderKey?: MessageKey;
        disabled?: boolean;
        protectOptionText?: boolean;
    }

    interface Emits {
        (e: 'update:modelValue', value: T): void;
        (e: 'update:open', value: boolean): void;
    }

    const props = withDefaults(defineProps<Props>(), {
        placeholder: '',
        disabled: false,
        protectOptionText: false,
    });

    const emit = defineEmits<Emits>();
    const attrs = useAttrs();

    const isOpen = ref(false);

    const selectedOption = computed(() => {
        return props.options.find((opt) => opt.value === props.modelValue);
    });

    const resolvedPlaceholder = computed(() => {
        if (props.placeholderKey) {
            return t(props.placeholderKey);
        }
        return props.placeholder ? tt(props.placeholder) : t('common.selectPlaceholder');
    });

    const selectOption = (value: T) => {
        emit('update:modelValue', value);
    };

    const handleSelectValue = (value: AcceptableValue) => {
        if (typeof value === 'string' || typeof value === 'number') {
            selectOption(value as T);
        }
    };

    const handleOpenChange = (value: boolean) => {
        isOpen.value = value;
        emit('update:open', value);
    };
</script>

<template>
    <Select
        :model-value="modelValue"
        :disabled="disabled"
        :open="isOpen"
        @update:model-value="handleSelectValue"
        @update:open="handleOpenChange"
    >
        <SelectTrigger
            v-bind="attrs"
            class="w-full rounded-[10px] border px-3 py-2 text-left font-serif text-sm shadow-none [box-shadow:none] transition-colors"
            :class="{
                'border-transparent bg-[#f0f0ef] text-gray-900 hover:bg-[#ececea]': !disabled,
                'cursor-not-allowed border-transparent bg-gray-50 text-gray-400': disabled,
                'border-primary-300 bg-white': isOpen,
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
                        :data-no-i18n="protectOptionText ? 'true' : undefined"
                        :translate="protectOptionText ? 'no' : undefined"
                    />
                    <span
                        class="line-clamp-1"
                        :data-no-i18n="protectOptionText ? 'true' : undefined"
                        :translate="protectOptionText ? 'no' : undefined"
                    >
                        {{ selectedOption.label }}
                    </span>
                </div>
            </template>
            <SelectValue v-else :placeholder="resolvedPlaceholder" />
        </SelectTrigger>

        <SelectContent
            class="w-[var(--reka-select-trigger-width)] rounded-[10px] border border-gray-200 bg-white py-1 shadow-lg"
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
                        :data-no-i18n="protectOptionText ? 'true' : undefined"
                        :translate="protectOptionText ? 'no' : undefined"
                    />
                    <div class="min-w-0 flex-1">
                        <span
                            class="block truncate font-serif font-medium"
                            :data-no-i18n="protectOptionText ? 'true' : undefined"
                            :translate="protectOptionText ? 'no' : undefined"
                        >
                            {{ option.label }}
                        </span>
                        <span
                            v-if="option.description"
                            class="mt-0.5 block truncate text-xs text-gray-400"
                            :data-no-i18n="protectOptionText ? 'true' : undefined"
                            :translate="protectOptionText ? 'no' : undefined"
                        >
                            {{ option.description }}
                        </span>
                    </div>
                </div>
            </SelectItem>
        </SelectContent>
    </Select>
</template>
