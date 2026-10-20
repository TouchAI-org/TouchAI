<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    defineOptions({
        name: 'UiButton',
    });

    import { cva, type VariantProps } from 'class-variance-authority';
    import { Primitive, type PrimitiveProps } from 'reka-ui';
    import type { HTMLAttributes } from 'vue';
    import { computed } from 'vue';

    import { cn } from '@/lib/utils';

    /*
     * layout 轴存在的理由：
     *
     * 项目里有三族按钮，它们的「基础类」就不同，不只是颜色不同：
     *   - default 族（ui/button 既有）：inline-flex / rounded-md / text-sm /
     *     disabled:pointer-events-none
     *   - settings 族（原 .settings-button-*）：rounded-[9px] / text-[12px] /
     *     px-3.5 py-1.5 / disabled:cursor-not-allowed
     *   - icon 族（原 .settings-icon-button）：flex h-8 w-8 /
     *     rounded-[9px] / 无字号 / 无内边距
     *
     * 若把它们塞进同一个 base，会产生十几处声明冲突，且 disabled:pointer-events-none
     * 会让 disabled:cursor-not-allowed 永久失效（光标由指针下方元素决定）。
     * 因此把「布局与尺寸体系」抽成独立的 layout 轴，与颜色（variant）正交。
     *
     * layout 不对外暴露为业务概念：调用点只写 variant，由 resolveLayout 推导。
     */
    const buttonVariants = cva('', {
        variants: {
            layout: {
                default:
                    'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium t-press disabled:pointer-events-none disabled:opacity-50',
                settings:
                    'rounded-[9px] px-3.5 py-1.5 text-[12px] font-medium shadow-none transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                icon: 'flex h-8 w-8 items-center justify-center rounded-[9px] transition-colors disabled:cursor-not-allowed disabled:opacity-50',
            },
            variant: {
                default: 'bg-primary-500 text-white hover:bg-primary-600',
                strong: 'bg-primary-700 text-white hover:bg-primary-600',
                destructive: 'bg-red-500 text-white hover:bg-red-600',
                danger: 'bg-red-600 text-white hover:bg-red-700',
                outline: 'border border-gray-200 bg-white text-gray-600 hover:border-gray-300',
                'outline-neutral':
                    'border border-neutral-200/80 bg-white text-neutral-700 hover:border-neutral-300/80 hover:bg-neutral-50',
                secondary: 'bg-gray-100 text-gray-900 hover:bg-gray-200',
                ghost: 'text-gray-600 hover:bg-gray-100',
                'ghost-neutral': 'text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700',
                link: 'text-primary-600 underline-offset-4 hover:underline',
            },
            size: {
                default: 'h-9 px-4 py-2',
                sm: 'h-8 rounded-md px-3 text-xs',
                lg: 'h-10 rounded-md px-8',
                icon: 'h-9 w-9',
                'icon-sm': 'h-7 w-7',
                'icon-md': 'h-8 w-8',
            },
        },
        defaultVariants: {
            layout: 'default',
            variant: 'default',
            // 故意不设 size 默认值：settings 族的尺寸已写在 layout 里，
            // 若在此回填 'default'，cva 会加上 h-9 px-4 py-2，与 layout 的
            // px-3.5 py-1.5 产生非同类属性冲突（h-9 与 py-1.5 同时生效）。
            // 由 resolvedClass 按 layout 决定是否传入 size。
        },
    });

    type ButtonVariants = VariantProps<typeof buttonVariants>;
    type ButtonVariant = NonNullable<ButtonVariants['variant']>;
    type ButtonSize = NonNullable<ButtonVariants['size']>;

    /**
     * 从 variant 推导 layout。settings 族与 icon 族的尺寸自带在 layout 内，
     * 不参与 size 轴，因此 size 对它们无意义。
     */
    const SETTINGS_VARIANTS = new Set<ButtonVariant>(['strong', 'outline-neutral', 'danger']);
    const ICON_VARIANTS = new Set<ButtonVariant>(['ghost-neutral']);

    const resolveLayout = (variant: ButtonVariant): ButtonVariants['layout'] => {
        if (SETTINGS_VARIANTS.has(variant)) {
            return 'settings';
        }
        if (ICON_VARIANTS.has(variant)) {
            return 'icon';
        }
        return 'default';
    };

    interface Props extends PrimitiveProps {
        variant?: ButtonVariant;
        size?: ButtonSize;
        class?: HTMLAttributes['class'];
    }

    const props = withDefaults(defineProps<Props>(), {
        as: 'button',
        variant: 'default',
        // size 不设默认值，原因见 defaultVariants 处的注释
        class: '',
    });
    const delegatedProps = computed(() => {
        const delegated = { ...props } as Record<string, unknown>;
        delete delegated.class;
        delete delegated.variant;
        delete delegated.size;
        // 原生 <button> 在表单内默认是 submit。本项目当前没有 <form>，
        // 但迁移时原调用点多写有 type="button"，保持该语义以免将来引入表单时
        // 意外提交。调用点显式传 type 时以调用点为准。
        if (delegated.as === 'button' && delegated.type === undefined) {
            delegated.type = 'button';
        }
        return delegated;
    });

    const resolvedClass = computed(() => {
        const layout = resolveLayout(props.variant);

        return cn(
            buttonVariants({
                layout,
                variant: props.variant,
                // settings / icon 族的尺寸已包含在 layout 内，传 size 会与之冲突。
                // default 族未传 size 时显式回落为 'default'，保证现有调用点
                // （它们不传 size）仍然输出 h-9 px-4 py-2。
                size: layout === 'default' ? (props.size ?? 'default') : undefined,
            }),
            props.class
        );
    });
</script>

<template>
    <Primitive v-bind="delegatedProps" :class="resolvedClass">
        <slot />
    </Primitive>
</template>
