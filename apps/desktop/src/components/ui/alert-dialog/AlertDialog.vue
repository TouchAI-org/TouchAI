<script setup lang="ts">
    import { type AlertDialogEmits, type AlertDialogProps, AlertDialogRoot } from 'reka-ui';
    import { useForwardPropsEmits } from 'reka-ui';

    const props = defineProps<AlertDialogProps>();
    const emits = defineEmits<AlertDialogEmits>();

    const forwarded = useForwardPropsEmits(props, emits);
</script>

<template>
    <AlertDialogRoot v-bind="forwarded">
        <slot />
    </AlertDialogRoot>
</template>
