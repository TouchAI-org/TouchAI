<!-- Copyright (c) 2026. Qian Cheng. Licensed under GPL v3 -->

<script setup lang="ts">
    defineOptions({
        name: 'UiTextarea',
        inheritAttrs: false,
    });

    import { cva, type VariantProps } from 'class-variance-authority';
    import type { HTMLAttributes, TextareaHTMLAttributes } from 'vue';
    import { computed, ref, useAttrs } from 'vue';

    import { cn } from '@/lib/utils';

    const textareaVariants = cva(
        'focus:border-primary-400 t-control min-h-24 w-full resize-y rounded-control border border-border bg-surface-floating px-3 py-2 text-compact text-text-primary shadow-none [box-shadow:none] focus:shadow-none focus:[box-shadow:none] focus:outline-none disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-text-tertiary',
        {
            variants: {
                variant: {
                    default: '',
                    filled: 'focus:border-primary-300 rounded-control border-transparent bg-surface-sunken px-3 py-2 text-compact text-text-primary hover:bg-surface-active focus:bg-surface-floating',
                },
            },
            defaultVariants: {
                variant: 'default',
            },
        }
    );

    type TextareaVariants = VariantProps<typeof textareaVariants>;
    type TextareaVariant = NonNullable<TextareaVariants['variant']>;

    interface Props {
        class?: HTMLAttributes['class'];
        modelValue?: string | null;
        placeholder?: string;
        disabled?: boolean;
        id?: string;
        name?: string;
        rows?: TextareaHTMLAttributes['rows'];
        variant?: TextareaVariant;
    }

    interface Emits {
        (event: 'update:modelValue', value: string): void;
        (event: 'input', nativeEvent: Event): void;
        (event: 'focus', nativeEvent: FocusEvent): void;
        (event: 'blur', nativeEvent: FocusEvent): void;
    }

    const props = withDefaults(defineProps<Props>(), {
        modelValue: '',
        class: '',
        placeholder: '',
        id: undefined,
        name: undefined,
        rows: 4,
        variant: 'default',
    });
    const emit = defineEmits<Emits>();
    const attrs = useAttrs();
    const textareaRef = ref<HTMLTextAreaElement | null>(null);

    defineExpose({
        focus: () => textareaRef.value?.focus(),
        blur: () => textareaRef.value?.blur(),
        select: () => textareaRef.value?.select(),
        el: textareaRef,
    });

    const value = computed(() => (props.modelValue == null ? '' : String(props.modelValue)));
    const resolvedClass = computed(() =>
        cn(textareaVariants({ variant: props.variant }), props.class)
    );

    function handleInput(event: Event) {
        emit('update:modelValue', (event.target as HTMLTextAreaElement).value);
        emit('input', event);
    }
</script>

<template>
    <textarea
        v-bind="attrs"
        :id="id"
        ref="textareaRef"
        :value="value"
        :placeholder="placeholder"
        :disabled="disabled"
        :name="name"
        :rows="rows"
        :class="resolvedClass"
        @input="handleInput"
        @focus="$emit('focus', $event)"
        @blur="$emit('blur', $event)"
    />
</template>
