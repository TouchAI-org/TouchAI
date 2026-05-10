<script setup lang="ts">
    import {
        DropdownMenuContent,
        type DropdownMenuContentEmits,
        type DropdownMenuContentProps,
        DropdownMenuPortal,
        useForwardPropsEmits,
    } from 'reka-ui';
    import type { HTMLAttributes } from 'vue';
    import { computed } from 'vue';

    import { cn } from '@/lib/utils';

    interface Props extends DropdownMenuContentProps {
        class?: HTMLAttributes['class'];
    }

    const props = withDefaults(defineProps<Props>(), {
        sideOffset: 4,
        class: '',
    });
    const emits = defineEmits<DropdownMenuContentEmits>();

    const delegatedProps = computed(() => {
        const delegated = { ...props };
        Reflect.deleteProperty(delegated, 'class');
        return delegated;
    });

    const forwarded = useForwardPropsEmits(delegatedProps, emits);
</script>

<template>
    <DropdownMenuPortal>
        <DropdownMenuContent
            v-bind="forwarded"
            :class="
                cn(
                    'z-50 min-w-[160px] rounded-lg border border-gray-200 bg-white py-1 shadow-lg',
                    'data-[state=open]:animate-in data-[state=closed]:animate-out',
                    props.class
                )
            "
        >
            <slot />
        </DropdownMenuContent>
    </DropdownMenuPortal>
</template>
