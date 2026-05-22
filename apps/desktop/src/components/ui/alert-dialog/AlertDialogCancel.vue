<script setup lang="ts">
    import { AlertDialogCancel, type AlertDialogCancelProps, useForwardProps } from 'reka-ui';
    import type { HTMLAttributes } from 'vue';
    import { computed } from 'vue';

    import { cn } from '@/lib/utils';

    interface Props extends AlertDialogCancelProps {
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
    <AlertDialogCancel
        v-bind="forwarded"
        :class="
            cn(
                'flex-1 rounded-lg border border-gray-200 px-4 py-2 font-serif text-sm font-medium text-gray-600 transition-colors hover:border-gray-300 hover:bg-gray-50',
                props.class
            )
        "
    >
        <slot />
    </AlertDialogCancel>
</template>
