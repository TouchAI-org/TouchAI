<script setup lang="ts">
    defineOptions({
        name: 'UiSelect',
    });

    import { SelectRoot, type SelectRootEmits, type SelectRootProps } from 'reka-ui';
    import { useForwardPropsEmits } from 'reka-ui';

    const props = defineProps<SelectRootProps>();
    const emits = defineEmits<SelectRootEmits>();

    const forwarded = useForwardPropsEmits(props, emits);
</script>

<template>
    <SelectRoot v-bind="forwarded">
        <slot />
    </SelectRoot>
</template>
