<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import { useMotion } from '@composables/useMotion';
    import { motion } from 'motion-v';
    import { type HTMLAttributes, useId } from 'vue';

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
    const instanceId = useId();
    const { transitions } = useMotion();

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
                'relative inline-flex shrink-0 items-center rounded-md border border-border-subtle bg-surface-sunken p-0.5',
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
                    'relative rounded px-1.5 py-0.5 text-2xs transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                    model === option.value
                        ? 'text-text-primary'
                        : 'text-text-tertiary hover:text-text-secondary'
                )
            "
            @click="select(option)"
        >
            <motion.span
                v-if="model === option.value"
                layout
                :layout-id="`${instanceId}-highlight`"
                :transition="transitions.fast"
                class="absolute inset-0 rounded bg-surface-floating shadow-sm"
            />
            <span class="relative">{{ option.label }}</span>
        </button>
    </div>
</template>
