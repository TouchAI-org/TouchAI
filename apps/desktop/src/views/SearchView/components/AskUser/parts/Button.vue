<!--
  Ported from https://www.fluidfunctionalism.com/r/button.json
  Upstream: registry/radix/button.tsx
  Adapted: minimal subset — only `ghost` and `primary` variants, size `sm`.
-->

<template>
    <button
        :class="[
            baseClasses,
            sizeClasses,
            variantClasses,
            shape.button,
            iconLeftPad,
            iconRightPad,
            $attrs.class as string,
        ]"
        :disabled="disabled"
        @click="(e) => emit('click', e)"
    >
        <span
            aria-hidden
            :class="['absolute inset-0 rounded-[inherit] transition-colors duration-80', bgClass]"
        />
        <span class="relative inline-flex items-center justify-center gap-1.5">
            <component
                :is="leadingIcon"
                v-if="leadingIcon"
                :size="14"
                :stroke-width="1.5"
                class="transition-[stroke-width] duration-80 group-hover:stroke-[2]"
            />
            <span v-if="$slots.default"><slot /></span>
            <component
                :is="trailingIcon"
                v-if="trailingIcon"
                :size="14"
                :stroke-width="1.5"
                class="transition-[stroke-width] duration-80 group-hover:stroke-[2]"
            />
        </span>
    </button>
</template>

<script setup lang="ts">
    import { type Component, computed } from 'vue';

    import { shape } from '../lib/shape';

    interface Props {
        variant?: 'primary' | 'ghost';
        disabled?: boolean;
        leadingIcon?: Component;
        trailingIcon?: Component;
    }

    const props = withDefaults(defineProps<Props>(), {
        variant: 'ghost',
        disabled: false,
    });

    const emit = defineEmits<{
        click: [event: MouseEvent];
    }>();

    defineOptions({ name: 'AskButton', inheritAttrs: false });

    const baseClasses =
        'group relative isolate inline-flex items-center justify-center outline-none cursor-pointer ' +
        'transition-colors duration-80 disabled:opacity-50 disabled:pointer-events-none ' +
        'focus-visible:ring-1 focus-visible:ring-[#6B97FF]';
    const sizeClasses = 'h-7 px-3 text-[12px] gap-1';

    const variantClasses = computed(() =>
        props.variant === 'primary'
            ? 'text-background'
            : 'text-muted-foreground hover:text-foreground'
    );

    const bgClass = computed(() =>
        props.variant === 'primary'
            ? 'bg-foreground group-hover:bg-foreground/90 group-active:bg-foreground/80'
            : 'bg-transparent group-hover:bg-hover group-active:bg-active'
    );

    const iconLeftPad = computed(() => (props.leadingIcon ? 'pl-[6px]' : ''));
    const iconRightPad = computed(() => (props.trailingIcon ? 'pr-[6px]' : ''));
</script>
