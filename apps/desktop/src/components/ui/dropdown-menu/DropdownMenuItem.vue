<script setup lang="ts">
    import { DropdownMenuItem, type DropdownMenuItemProps, useForwardProps } from 'reka-ui';
    import type { HTMLAttributes } from 'vue';
    import { computed } from 'vue';

    import { cn } from '@/lib/utils';

    interface Props extends DropdownMenuItemProps {
        class?: HTMLAttributes['class'];
    }

    const props = defineProps<Props>();

    const delegatedProps = computed(() => {
        const delegated = { ...props };
        delete delegated.class;
        return delegated;
    });

    const forwarded = useForwardProps(delegatedProps);
</script>

<template>
    <DropdownMenuItem
        v-bind="forwarded"
        :class="
            cn(
                'flex cursor-pointer items-center gap-2 px-3 py-2 text-sm transition-colors',
                'outline-none focus:bg-gray-100 data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
                props.class
            )
        "
    >
        <slot />
    </DropdownMenuItem>
</template>
