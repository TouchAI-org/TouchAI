<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    defineOptions({
        name: 'UiPopoverContent',
    });

    import {
        PopoverContent,
        type PopoverContentEmits,
        type PopoverContentProps,
        PopoverPortal,
        useForwardPropsEmits,
    } from 'reka-ui';
    import type { HTMLAttributes } from 'vue';
    import { computed } from 'vue';

    import { cn } from '@/lib/utils';

    interface Props extends PopoverContentProps {
        class?: HTMLAttributes['class'];
    }

    const props = withDefaults(defineProps<Props>(), {
        align: 'start',
        sideOffset: 4,
        class: '',
    });

    const emits = defineEmits<PopoverContentEmits>();

    const delegatedProps = computed(() => {
        const delegated = { ...props };
        Reflect.deleteProperty(delegated, 'class');
        return delegated;
    });

    const forwarded = useForwardPropsEmits(delegatedProps, emits);
</script>

<template>
    <PopoverPortal>
        <PopoverContent
            v-bind="forwarded"
            :class="
                cn(
                    'z-50 overflow-hidden rounded-lg border border-stone-200/90 bg-white shadow-lg',
                    props.class
                )
            "
        >
            <slot />
        </PopoverContent>
    </PopoverPortal>
</template>
