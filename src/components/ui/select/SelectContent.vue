<script setup lang="ts">
    import {
        SelectContent,
        type SelectContentEmits,
        type SelectContentProps,
        SelectPortal,
        SelectViewport,
        useForwardPropsEmits,
    } from 'reka-ui';
    import type { HTMLAttributes } from 'vue';
    import { computed } from 'vue';

    import { cn } from '@/lib/utils';

    interface Props extends SelectContentProps {
        class?: HTMLAttributes['class'];
    }

    const props = withDefaults(defineProps<Props>(), {
        class: '',
        position: 'popper',
        side: 'bottom',
        align: 'start',
        sideOffset: 4,
        avoidCollisions: true,
    });

    const emits = defineEmits<SelectContentEmits>();

    const delegatedProps = computed(() => {
        const delegated = { ...props };
        Reflect.deleteProperty(delegated, 'class');
        return delegated;
    });

    const forwarded = useForwardPropsEmits(delegatedProps, emits);
</script>

<template>
    <SelectPortal>
        <SelectContent
            v-bind="forwarded"
            :class="
                cn(
                    'relative z-50 min-w-[8rem] overflow-hidden rounded-lg border border-gray-200 bg-white py-1 text-gray-900 shadow-lg',
                    'data-[state=open]:animate-in data-[state=closed]:animate-out',
                    props.class
                )
            "
        >
            <SelectViewport
                class="max-h-[var(--reka-select-content-available-height)] overflow-y-auto p-0"
            >
                <slot />
            </SelectViewport>
        </SelectContent>
    </SelectPortal>
</template>
