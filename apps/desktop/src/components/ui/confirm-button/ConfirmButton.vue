<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import { Button } from '@components/ui/button';

    defineOptions({
        name: 'UiConfirmButton',
        inheritAttrs: false,
    });

    withDefaults(
        defineProps<{
            label: string;
            disabled?: boolean;
        }>(),
        {
            disabled: false,
        }
    );

    const emit = defineEmits<{
        click: [event: MouseEvent];
    }>();
</script>

<template>
    <Button
        v-bind="$attrs"
        variant="strong"
        size="icon"
        class="h-9 w-9 px-0 py-0"
        :disabled="disabled"
        :aria-label="label"
        @click="emit('click', $event)"
    >
        <AppIcon name="check-circle" class="size-4" />
    </Button>
</template>
