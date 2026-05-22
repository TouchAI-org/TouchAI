<script setup lang="ts">
    import { SelectItem, type SelectItemProps, useForwardProps } from 'reka-ui';
    import type { HTMLAttributes } from 'vue';
    import { computed } from 'vue';

    import { cn } from '@/lib/utils';

    interface Props extends SelectItemProps {
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
    <SelectItem
        v-bind="forwarded"
        :class="
            cn(
                'relative w-full cursor-pointer text-left transition-colors outline-none select-none',
                'data-[highlighted]:bg-gray-100',
                'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
                props.class
            )
        "
    >
        <slot />
    </SelectItem>
</template>
