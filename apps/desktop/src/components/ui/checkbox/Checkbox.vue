<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import { CheckboxIndicator, CheckboxRoot } from 'reka-ui';

    defineOptions({ name: 'UiCheckbox' });
    defineProps<{ modelValue?: boolean | 'indeterminate'; disabled?: boolean }>();
    const emit = defineEmits<{ 'update:modelValue': [value: boolean | 'indeterminate'] }>();
</script>

<template>
    <CheckboxRoot
        :model-value="modelValue"
        :disabled="disabled"
        class="flex size-4 shrink-0 items-center justify-center rounded-xs border border-border-strong bg-surface-floating text-text-inverse focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary"
        @update:model-value="emit('update:modelValue', $event)"
    >
        <CheckboxIndicator class="flex items-center justify-center">
            <AppIcon
                :name="modelValue === 'indeterminate' ? 'minimize' : 'check'"
                class="size-3"
                aria-hidden="true"
            />
        </CheckboxIndicator>
    </CheckboxRoot>
</template>
