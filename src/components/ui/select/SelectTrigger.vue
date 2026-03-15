<script setup lang="ts">
    import SvgIcon from '@components/SvgIcon.vue';
    import { SelectIcon, SelectTrigger, type SelectTriggerProps, useForwardProps } from 'reka-ui';
    import type { HTMLAttributes } from 'vue';
    import { computed } from 'vue';

    import { cn } from '@/lib/utils';

    interface Props extends SelectTriggerProps {
        class?: HTMLAttributes['class'];
        iconClass?: HTMLAttributes['class'];
    }

    const props = defineProps<Props>();

    const delegatedProps = computed(() => {
        const delegated = { ...props };
        delete delegated.class;
        delete delegated.iconClass;
        return delegated;
    });

    const forwarded = useForwardProps(delegatedProps);
</script>

<template>
    <SelectTrigger
        v-bind="forwarded"
        :class="
            cn(
                'focus:border-primary-400 flex h-9 w-full items-center justify-between rounded-lg border border-gray-200 bg-white px-3 py-2 text-left font-serif text-sm text-gray-900 transition-colors disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-400',
                props.class
            )
        "
    >
        <slot />
        <SelectIcon as-child>
            <SvgIcon
                name="chevron-down"
                :class="cn('h-4 w-4 text-gray-500 transition-transform', props.iconClass)"
            />
        </SelectIcon>
    </SelectTrigger>
</template>
