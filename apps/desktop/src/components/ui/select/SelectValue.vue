<script setup lang="ts">
    import { SelectValue, type SelectValueProps, useForwardProps } from 'reka-ui';
    import type { HTMLAttributes } from 'vue';
    import { computed } from 'vue';

    import { cn } from '@/lib/utils';

    interface Props extends SelectValueProps {
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
    <SelectValue v-bind="forwarded" :class="cn('line-clamp-1', props.class)">
        <slot />
    </SelectValue>
</template>
