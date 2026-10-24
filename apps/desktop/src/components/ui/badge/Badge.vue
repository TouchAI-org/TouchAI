<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    defineOptions({
        name: 'UiBadge',
    });

    import { cva, type VariantProps } from 'class-variance-authority';
    import { Primitive, type PrimitiveProps } from 'reka-ui';
    import type { HTMLAttributes } from 'vue';
    import { computed } from 'vue';

    import { cn } from '@/lib/utils';

    /*
     * 项目里有两族胶囊标签，结构和使用场景都不同，不能合并成一个 base：
     *
     *   toggle  能力开关 chip（AddModelDialog / EditModelDialog，共 10 处）
     *           <button>，可点击，有 active 双态，基础类
     *           rounded px-1.5 py-0.5 text-xs font-medium transition-colors
     *
     *   tag     能力展示标签（ModelCapabilityTags，内部循环 5 种色）
     *           <span>，不可点击，无 active 态，基础类
     *           inline-flex min-w-0 items-center rounded text-center font-medium
     *           break-words whitespace-normal + max-w-* 与字号由 size 决定
     *
     * tag 族缺了 min-w-0 / break-words / max-w-* 会在窄卡片里溢出，
     * 所以用 variant 区分「基础类」，而不是只区分颜色。
     */
    const badgeVariants = cva('', {
        variants: {
            variant: {
                toggle: 'rounded px-1.5 py-0.5 text-xs font-medium transition-colors',
                tag: 'inline-flex min-w-0 items-center rounded text-center font-medium break-words whitespace-normal',
            },
            size: {
                sm: 'max-w-[5.75rem] px-1 py-0.5 text-2xs leading-tight',
                md: 'max-w-[7.5rem] px-1.5 py-0.5 text-xs leading-tight',
                // toggle 族的尺寸已写在 variant 里，size=auto 时不追加任何尺寸类
                auto: '',
            },
            tone: {
                blue: '',
                green: '',
                purple: '',
                orange: '',
                indigo: '',
                gray: '',
                neutral: '',
            },
        },
        defaultVariants: {
            variant: 'toggle',
            size: 'auto',
            tone: 'neutral',
        },
    });

    type BadgeVariants = VariantProps<typeof badgeVariants>;
    type BadgeVariant = NonNullable<BadgeVariants['variant']>;
    type BadgeSize = NonNullable<BadgeVariants['size']>;
    type BadgeTone = NonNullable<BadgeVariants['tone']>;

    interface Props extends PrimitiveProps {
        variant?: BadgeVariant;
        size?: BadgeSize;
        tone?: BadgeTone;
        /** 仅 toggle 族有意义：开启时用 tone 色，关闭时统一用 neutral */
        active?: boolean;
        class?: HTMLAttributes['class'];
    }

    const props = withDefaults(defineProps<Props>(), {
        as: 'span',
        variant: 'toggle',
        size: 'auto',
        tone: 'neutral',
        active: true,
        class: '',
    });

    /*
     * 颜色表。toggle 族开启时带 hover 变体，tag 族是纯色块无 hover。
     * 关闭态统一为 neutral：bg-neutral-100 text-neutral-400 hover:bg-neutral-200
     */
    const TONE_CLASSES: Record<BadgeTone, { solid: string; hover: string }> = {
        blue: { solid: 'bg-blue-50 text-blue-600', hover: 'hover:bg-blue-100' },
        green: { solid: 'bg-green-50 text-green-600', hover: 'hover:bg-green-100' },
        purple: { solid: 'bg-purple-50 text-purple-600', hover: 'hover:bg-purple-100' },
        orange: { solid: 'bg-orange-50 text-orange-600', hover: 'hover:bg-orange-100' },
        indigo: { solid: 'bg-indigo-50 text-indigo-600', hover: 'hover:bg-indigo-100' },
        gray: { solid: 'bg-gray-100 text-gray-500', hover: '' },
        neutral: {
            solid: 'bg-neutral-100 text-neutral-400',
            hover: 'hover:bg-neutral-200',
        },
    };

    const toneClass = computed(() => {
        // toggle 族关闭态固定用 neutral
        if (props.variant === 'toggle' && !props.active) {
            const off = TONE_CLASSES.neutral;
            return cn(off.solid, off.hover);
        }
        const entry = TONE_CLASSES[props.tone];
        // tag 族没有 hover 变色
        return props.variant === 'tag' ? entry.solid : cn(entry.solid, entry.hover);
    });

    const delegatedProps = computed(() => {
        const delegated = { ...props } as Record<string, unknown>;
        delete delegated.class;
        delete delegated.variant;
        delete delegated.size;
        delete delegated.tone;
        delete delegated.active;
        return delegated;
    });

    const resolvedClass = computed(() =>
        cn(
            badgeVariants({ variant: props.variant, size: props.size, tone: props.tone }),
            toneClass.value,
            props.class
        )
    );
</script>

<template>
    <Primitive v-bind="delegatedProps" :class="resolvedClass">
        <slot />
    </Primitive>
</template>
