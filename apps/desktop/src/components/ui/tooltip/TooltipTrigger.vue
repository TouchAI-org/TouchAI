<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    defineOptions({
        name: 'UiTooltipTrigger',
    });

    import {
        TooltipTrigger as RekaTooltipTrigger,
        type TooltipTriggerProps,
        useForwardProps,
    } from 'reka-ui';
    import { computed } from 'vue';

    type Props = TooltipTriggerProps;

    const props = defineProps<Props>();

    const delegatedProps = computed(() => ({ ...props }));

    const forwarded = useForwardProps(delegatedProps);
</script>

<template>
    <RekaTooltipTrigger v-bind="forwarded">
        <slot />
    </RekaTooltipTrigger>
</template>
