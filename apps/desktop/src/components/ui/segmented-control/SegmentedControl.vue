<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import type { HTMLAttributes } from 'vue';

    import { cn } from '@/lib/utils';

    defineOptions({
        name: 'UiSegmentedControl',
        inheritAttrs: false,
    });

    interface Option {
        value: string;
        label: string;
        disabled?: boolean;
    }

    const props = withDefaults(
        defineProps<{
            options: Option[];
            ariaLabel?: string;
            disabled?: boolean;
            class?: HTMLAttributes['class'];
        }>(),
        {
            ariaLabel: undefined,
            disabled: false,
            class: '',
        }
    );

    const model = defineModel<string>({ required: true });

    function select(option: Option) {
        if (props.disabled || option.disabled) return;
        model.value = option.value;
    }
</script>

<template>
    <div
        v-bind="$attrs"
        role="group"
        :aria-label="ariaLabel"
        :class="
            cn(
                'inline-flex shrink-0 items-center rounded-md border border-border-subtle bg-surface-sunken p-0.5',
                props.class
            )
        "
    >
        <button
            v-for="option in options"
            :key="option.value"
            type="button"
            :aria-pressed="model === option.value"
            :aria-disabled="disabled || option.disabled || undefined"
            :disabled="disabled || option.disabled"
            :class="
                cn(
                    'rounded px-1.5 py-0.5 text-2xs transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                    model === option.value
                        ? 'bg-white text-text-primary shadow-sm'
                        : 'text-text-tertiary hover:text-text-secondary'
                )
            "
            @click="select(option)"
        >
            {{ option.label }}
        </button>
    </div>
</template>
