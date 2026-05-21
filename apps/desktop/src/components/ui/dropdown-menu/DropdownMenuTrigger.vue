<script setup lang="ts">
    import { DropdownMenuTrigger, type DropdownMenuTriggerProps } from 'reka-ui';
    import { useForwardProps } from 'reka-ui';

    const props = defineProps<DropdownMenuTriggerProps>();

    const forwarded = useForwardProps(props);
</script>

<template>
    <DropdownMenuTrigger v-bind="forwarded">
        <slot />
    </DropdownMenuTrigger>
</template>
