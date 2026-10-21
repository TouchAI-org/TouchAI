<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    defineOptions({
        name: 'UiPopover',
    });

    import {
        PopoverRoot,
        type PopoverRootEmits,
        type PopoverRootProps,
        useForwardPropsEmits,
    } from 'reka-ui';

    type Props = PopoverRootProps;

    const props = defineProps<Props>();
    const emits = defineEmits<PopoverRootEmits>();

    const forwarded = useForwardPropsEmits(props, emits);
</script>

<template>
    <PopoverRoot v-bind="forwarded">
        <slot />
    </PopoverRoot>
</template>
