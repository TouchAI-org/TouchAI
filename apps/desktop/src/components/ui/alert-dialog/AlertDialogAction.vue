<script setup lang="ts">
    import { AlertDialogAction, type AlertDialogActionProps, useForwardProps } from 'reka-ui';
    import type { HTMLAttributes } from 'vue';
    import { computed } from 'vue';

    import { cn } from '@/lib/utils';

    interface Props extends AlertDialogActionProps {
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
    <AlertDialogAction
        v-bind="forwarded"
        :class="
            cn(
                'flex-1 rounded-lg px-4 py-2 font-serif text-sm font-medium text-white transition-colors',
                props.class
            )
        "
    >
        <slot />
    </AlertDialogAction>
</template>
