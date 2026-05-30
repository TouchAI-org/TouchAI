<!--
  Ported from registry/default/ask-user-questions.tsx (Row subcomponent).
  Adapted: React effect-based registerItem → Vue mount/unmount lifecycle.
-->

<template>
    <div
        ref="rowRef"
        :data-proximity-index="index"
        :data-state="isSelected ? 'checked' : 'unchecked'"
        :role="role ?? undefined"
        :aria-checked="ariaCheckedAttr"
        :aria-label="ariaLabel"
        :tabindex="tabIndex"
        :class="[
            'ask-row-pad relative z-10 flex cursor-pointer items-center gap-3 outline-none select-none',
            bodyLayout === 'stacked' ? 'min-h-14 py-2' : 'min-h-10 py-1.5',
            shape.item,
        ]"
        @focus="handleFocus"
        @blur="onBlurAny"
        @click="onClick"
        @keydown="onKeyDown"
    >
        <span
            :class="[
                'min-w-0 flex-1 text-[13px] leading-snug',
                bodyLayout === 'stacked'
                    ? 'flex flex-col gap-0.5'
                    : 'inline-flex items-center gap-0',
            ]"
        >
            <slot />
        </span>

        <span class="relative inline-flex h-7 w-7 shrink-0 items-center justify-center">
            <span
                aria-hidden
                :class="[
                    'absolute inline-flex h-5 w-5 items-center justify-center text-[11px] transition-opacity duration-80',
                    isMulti ? shape.bg : '',
                    isMulti
                        ? chipFilled
                            ? 'bg-foreground text-background'
                            : 'border-border text-muted-foreground border'
                        : chipFilled
                          ? 'text-foreground'
                          : 'text-muted-foreground',
                    showArrow ? 'opacity-0' : '',
                ]"
                :style="{ fontWeight: chipFilled ? fontWeights.semibold : fontWeights.medium }"
            >
                <slot name="chip">{{ chipContent }}</slot>
            </span>

            <AnimatePresence>
                <motion.span
                    v-if="showArrow"
                    :aria-hidden="!onArrowClick ? 'true' : 'false'"
                    :role="onArrowClick ? 'button' : undefined"
                    :class="[
                        'bg-foreground text-background absolute inset-0 inline-flex items-center justify-center',
                        shape.bg,
                        onArrowClick ? 'cursor-pointer' : '',
                    ]"
                    :initial="{ opacity: 0, scale: 0.6 }"
                    :animate="{ opacity: 1, scale: 1 }"
                    :exit="{ opacity: 0, scale: 0.6, transition: { duration: 0.06 } }"
                    :transition="{ ...springs.fast, opacity: { duration: 0.08 } }"
                    @click="handleArrowClick"
                >
                    <AppIcon name="arrow-right" class="h-3.5 w-3.5" />
                </motion.span>
            </AnimatePresence>
        </span>
    </div>
</template>

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import { AnimatePresence, motion } from 'motion-v';

    defineOptions({ name: 'AskUserRow' });
    import { computed, onMounted, onUnmounted, ref } from 'vue';

    import { fontWeights } from '../lib/fontWeights';
    import { shape } from '../lib/shape';
    import { springs } from '../lib/springs';

    interface Props {
        index: number;
        registerItem: (index: number, element: HTMLElement | null) => void;
        role: 'radio' | 'checkbox' | null;
        isSelected: boolean;
        tabIndex: number;
        isMulti: boolean;
        chipContent: string | number;
        chipFilled: boolean;
        ariaLabel?: string;
        ariaChecked?: boolean;
        showArrow?: boolean;
        onArrowClick?: () => void;
        bodyLayout?: 'inline' | 'stacked';
        onFocusVisible: () => void;
        onBlurAny: () => void;
        onClick: () => void;
        onKeyDown?: (e: KeyboardEvent) => void;
    }

    const props = withDefaults(defineProps<Props>(), {
        bodyLayout: 'inline',
        showArrow: false,
    });

    const rowRef = ref<HTMLDivElement | null>(null);

    const ariaCheckedAttr = computed(() =>
        props.role === 'radio' || props.role === 'checkbox' ? !!props.ariaChecked : undefined
    );

    function handleFocus(e: FocusEvent): void {
        const target = e.target as HTMLElement | null;
        if (target?.matches(':focus-visible')) {
            props.onFocusVisible();
        }
    }

    function handleArrowClick(e: MouseEvent): void {
        if (!props.onArrowClick) return;
        e.stopPropagation();
        props.onArrowClick();
    }

    onMounted(() => {
        props.registerItem(props.index, rowRef.value);
    });
    onUnmounted(() => {
        props.registerItem(props.index, null);
    });
</script>
