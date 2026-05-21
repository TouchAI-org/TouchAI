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

    const buttonVariants = cva(
        'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50',
        {
            variants: {
                variant: {
                    default: 'bg-primary-500 text-white hover:bg-primary-600',
                    destructive: 'bg-red-500 text-white hover:bg-red-600',
                    outline: 'border border-gray-200 bg-white text-gray-600 hover:border-gray-300',
                    secondary: 'bg-gray-100 text-gray-900 hover:bg-gray-200',
                    ghost: 'text-gray-600 hover:bg-gray-100',
                    link: 'text-primary-600 underline-offset-4 hover:underline',
                },
                size: {
                    default: 'h-9 px-4 py-2',
                    sm: 'h-8 rounded-md px-3 text-xs',
                    lg: 'h-10 rounded-md px-8',
                    icon: 'h-9 w-9',
                },
            },
            defaultVariants: {
                variant: 'default',
                size: 'default',
            },
        }
    );

    type ButtonVariants = VariantProps<typeof buttonVariants>;

    interface Props extends PrimitiveProps {
        variant?: ButtonVariants['variant'];
        size?: ButtonVariants['size'];
        class?: HTMLAttributes['class'];
    }

    const props = withDefaults(defineProps<Props>(), {
        as: 'button',
        variant: 'default',
        size: 'default',
        class: '',
    });

    const delegatedProps = computed(() => {
        const delegated = { ...props } as Record<string, unknown>;
        delete delegated.class;
        delete delegated.variant;
        delete delegated.size;
        return delegated;
    });
</script>

<template>
    <Primitive
        v-bind="delegatedProps"
        :class="cn(buttonVariants({ variant: props.variant, size: props.size }), props.class)"
    >
        <slot />
    </Primitive>
</template>
