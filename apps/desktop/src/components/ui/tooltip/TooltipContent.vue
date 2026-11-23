<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    defineOptions({
        name: 'UiTooltipContent',
        inheritAttrs: false,
    });

    import { previewCardVariants } from '@components/ui/preview-card';
    import {
        TooltipContent,
        type TooltipContentEmits,
        type TooltipContentProps,
        TooltipPortal,
        useForwardPropsEmits,
    } from 'reka-ui';
    import type { HTMLAttributes } from 'vue';
    import { computed, useAttrs } from 'vue';

    import { cn } from '@/lib/utils';

    interface Props extends TooltipContentProps {
        variant?: 'default' | 'preview' | 'preview-compact' | 'privacy';
        class?: HTMLAttributes['class'];
    }

    const props = withDefaults(defineProps<Props>(), {
        sideOffset: 6,
        variant: 'default',
        class: '',
    });

    const emits = defineEmits<TooltipContentEmits>();

    const delegatedProps = computed(() => {
        const delegated = { ...props };
        Reflect.deleteProperty(delegated, 'class');
        Reflect.deleteProperty(delegated, 'variant');
        return delegated;
    });

    const forwarded = useForwardPropsEmits(delegatedProps, emits);
    const attrs = useAttrs();
</script>

<template>
    <TooltipPortal>
        <TooltipContent
            v-bind="{ ...attrs, ...forwarded }"
            :class="
                cn(
                    props.variant === 'preview'
                        ? cn(
                              'z-50 max-w-72 font-serif text-xs leading-5 text-text-primary',
                              previewCardVariants({ variant: 'reference' })
                          )
                        : props.variant === 'privacy'
                          ? cn(
                                'z-50 w-max max-w-tooltip-available font-serif text-xs leading-5 text-text-primary',
                                previewCardVariants({ variant: 'reference-compact' })
                            )
                          : props.variant === 'preview-compact'
                            ? cn(
                                  'z-50 max-w-72 text-xs leading-5 text-text-primary',
                                  previewCardVariants({ variant: 'reference-compact' })
                              )
                            : 'z-50 max-w-xs rounded-md border border-neutral-200 bg-white px-2 py-1 text-xs leading-5 text-neutral-700 shadow-md',
                    props.class
                )
            "
        >
            <slot />
        </TooltipContent>
    </TooltipPortal>
</template>
