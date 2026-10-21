<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    defineOptions({
        name: 'UiPopoverTrigger',
    });

    import {
        PopoverTrigger as RekaPopoverTrigger,
        type PopoverTriggerProps,
        useForwardProps,
    } from 'reka-ui';
    import { computed } from 'vue';

    type Props = PopoverTriggerProps;

    const props = defineProps<Props>();
    const delegatedProps = computed(() => ({ ...props }));
    const forwarded = useForwardProps(delegatedProps);
</script>

<template>
    <RekaPopoverTrigger v-bind="forwarded">
        <slot />
    </RekaPopoverTrigger>
</template>
