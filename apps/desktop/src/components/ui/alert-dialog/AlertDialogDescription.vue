<script setup lang="ts">
    import {
        AlertDialogDescription,
        type AlertDialogDescriptionProps,
        useForwardProps,
    } from 'reka-ui';
    import type { HTMLAttributes } from 'vue';
    import { computed } from 'vue';

    import { cn } from '@/lib/utils';

    interface Props extends AlertDialogDescriptionProps {
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
    <AlertDialogDescription v-bind="forwarded" :class="cn('text-sm text-gray-600', props.class)">
        <slot />
    </AlertDialogDescription>
</template>
