<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import { useMotion } from '@composables/useMotion';
    import { motion } from 'motion-v';
    import {
        computed,
        type HTMLAttributes,
        nextTick,
        onBeforeUnmount,
        onMounted,
        ref,
        watch,
    } from 'vue';

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
    const { reducedMotion } = useMotion();
    const indicatorTransition = computed(() =>
        reducedMotion.value
            ? { duration: 0 }
            : { type: 'tween' as const, duration: 0.4, ease: [0.4, 0, 0.2, 1] }
    );
    const rootRef = ref<HTMLDivElement | null>(null);
    const indicator = ref({ x: 0, width: 0 });
    const ready = ref(false);
    let resizeObserver: ResizeObserver | null = null;

    function syncIndicator() {
        const root = rootRef.value;
        if (!root) return;
        const buttons = [...root.querySelectorAll<HTMLButtonElement>('button')];
        const activeIndex = props.options.findIndex((option) => option.value === model.value);
        const activeButton = buttons[activeIndex];
        if (!activeButton) return;
        indicator.value = { x: activeButton.offsetLeft, width: activeButton.offsetWidth };
        ready.value = true;
    }

    watch(
        () => [model.value, props.options.map((option) => option.value).join('|')],
        () => {
            void nextTick(syncIndicator);
        },
        { flush: 'post' }
    );

    onMounted(() => {
        void nextTick(syncIndicator);
        if (rootRef.value && typeof ResizeObserver !== 'undefined') {
            resizeObserver = new ResizeObserver(syncIndicator);
            resizeObserver.observe(rootRef.value);
        }
    });

    onBeforeUnmount(() => {
        resizeObserver?.disconnect();
        resizeObserver = null;
    });

    function select(option: Option) {
        if (props.disabled || option.disabled) return;
        model.value = option.value;
    }
</script>

<template>
    <div
        ref="rootRef"
        v-bind="$attrs"
        role="group"
        :aria-label="ariaLabel"
        :class="
            cn(
                'relative inline-flex shrink-0 items-center overflow-hidden rounded-md border border-border-subtle bg-surface-sunken p-0.5',
                props.class
            )
        "
    >
        <motion.span
            v-if="ready"
            :initial="false"
            :animate="{ x: indicator.x, width: indicator.width }"
            :transition="indicatorTransition"
            class="pointer-events-none absolute top-0.5 bottom-0.5 left-0 rounded bg-surface-floating shadow-sm"
        />
        <button
            v-for="option in options"
            :key="option.value"
            type="button"
            :aria-pressed="model === option.value"
            :aria-disabled="disabled || option.disabled || undefined"
            :disabled="disabled || option.disabled"
            :class="
                cn(
                    'relative z-10 rounded px-1.5 py-0.5 text-2xs text-settings-text transition-colors disabled:cursor-not-allowed disabled:opacity-50'
                )
            "
            @click="select(option)"
        >
            {{ option.label }}
        </button>
    </div>
</template>
