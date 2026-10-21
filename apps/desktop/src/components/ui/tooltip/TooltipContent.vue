<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    defineOptions({
        name: 'UiTooltipContent',
    });

    import {
        TooltipContent,
        type TooltipContentEmits,
        type TooltipContentProps,
        TooltipPortal,
        useForwardPropsEmits,
    } from 'reka-ui';
    import type { HTMLAttributes } from 'vue';
    import { computed } from 'vue';

    import { cn } from '@/lib/utils';

    interface Props extends TooltipContentProps {
        class?: HTMLAttributes['class'];
    }

    const props = withDefaults(defineProps<Props>(), {
        sideOffset: 6,
        class: '',
    });

    const emits = defineEmits<TooltipContentEmits>();

    const delegatedProps = computed(() => {
        const delegated = { ...props };
        Reflect.deleteProperty(delegated, 'class');
        return delegated;
    });

    const forwarded = useForwardPropsEmits(delegatedProps, emits);
</script>

<template>
    <TooltipPortal>
        <TooltipContent
            v-bind="forwarded"
            :class="
                cn(
                    'z-50 max-w-xs rounded-md border border-neutral-200 bg-white px-2 py-1 text-xs leading-5 text-neutral-700 shadow-md',
                    props.class
                )
            "
        >
            <slot />
        </TooltipContent>
    </TooltipPortal>
</template>
