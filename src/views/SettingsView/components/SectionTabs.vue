<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts" generic="T extends string">
    export interface SectionTabItem<TValue extends string = string> {
        value: TValue;
        label: string;
    }

    interface Props<TValue extends string> {
        modelValue: TValue;
        tabs: SectionTabItem<TValue>[];
    }

    const props = defineProps<Props<T>>();

    const emit = defineEmits<{
        'update:modelValue': [value: T];
    }>();

    function handleSelect(value: T) {
        if (value === props.modelValue) {
            return;
        }

        emit('update:modelValue', value);
    }
</script>

<template>
    <div
        class="border-b border-gray-200 bg-white px-6"
        style="padding-bottom: 1px; padding-top: 1px"
    >
        <div class="flex gap-6">
            <button
                v-for="tab in tabs"
                :key="tab.value"
                type="button"
                :class="[
                    'border-b-2 px-1 py-4 font-serif text-sm font-medium transition-colors',
                    modelValue === tab.value
                        ? 'border-primary-600 text-primary-600'
                        : 'border-transparent text-gray-500 hover:text-gray-700',
                ]"
                @click="handleSelect(tab.value)"
            >
                {{ tab.label }}
            </button>
        </div>
    </div>
</template>
