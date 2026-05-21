<script setup lang="ts">
    import { DialogTitle, type DialogTitleProps, useForwardProps } from 'reka-ui';
    import type { HTMLAttributes } from 'vue';
    import { computed } from 'vue';

    import { cn } from '@/lib/utils';

    interface Props extends DialogTitleProps {
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
    <DialogTitle
        v-bind="forwarded"
        :class="cn('font-serif text-base font-semibold text-gray-900', props.class)"
    >
        <slot />
    </DialogTitle>
</template>
