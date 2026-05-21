<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    defineOptions({
        name: 'UiInput',
    });

    import type { HTMLAttributes, InputHTMLAttributes } from 'vue';
    import { computed } from 'vue';

    import { cn } from '@/lib/utils';

    interface Props {
        class?: HTMLAttributes['class'];
        modelValue?: string | number | null;
        type?: InputHTMLAttributes['type'];
        placeholder?: string;
        disabled?: boolean;
        id?: string;
        name?: string;
        autocomplete?: string;
    }

    interface Emits {
        (e: 'update:modelValue', value: string): void;
        (e: 'input', event: Event): void;
        (e: 'focus', event: FocusEvent): void;
        (e: 'blur', event: FocusEvent): void;
    }

    const props = withDefaults(defineProps<Props>(), {
        modelValue: '',
        type: 'text',
        class: '',
        placeholder: '',
        id: undefined,
        name: undefined,
        autocomplete: undefined,
    });

    const emit = defineEmits<Emits>();

    const value = computed(() => (props.modelValue == null ? '' : String(props.modelValue)));

    const handleInput = (event: Event) => {
        const target = event.target as HTMLInputElement;
        emit('update:modelValue', target.value);
        emit('input', event);
    };
</script>

<template>
    <input
        :id="id"
        :value="value"
        :type="type"
        :placeholder="placeholder"
        :disabled="disabled"
        :name="name"
        :autocomplete="autocomplete"
        :class="
            cn(
                'focus:border-primary-400 flex h-9 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 transition-colors focus:outline-none disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-400',
                props.class
            )
        "
        @input="handleInput"
        @focus="$emit('focus', $event)"
        @blur="$emit('blur', $event)"
    />
</template>
