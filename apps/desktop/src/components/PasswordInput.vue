<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import type { AppIconName } from '@components/appIconMap';
    import { Button } from '@components/ui/button';
    import { Input } from '@components/ui/input';
    import { computed, ref } from 'vue';

    interface Props {
        modelValue: string;
        placeholder?: string;
        disabled?: boolean;
    }

    interface Emits {
        (e: 'update:modelValue', value: string): void;
        (e: 'input'): void;
    }

    withDefaults(defineProps<Props>(), {
        placeholder: '',
        disabled: false,
    });

    const emit = defineEmits<Emits>();

    const showPassword = ref(false);
    const visibilityIcon = computed<AppIconName>(() => (showPassword.value ? 'eye-off' : 'eye'));

    const togglePasswordVisibility = () => {
        showPassword.value = !showPassword.value;
    };

    const handleInput = (event: Event) => {
        const target = event.target as HTMLInputElement;
        emit('update:modelValue', target.value);
        emit('input');
    };
</script>

<template>
    <div class="relative mt-1.5">
        <Input
            :model-value="modelValue"
            :type="showPassword ? 'text' : 'password'"
            :placeholder="placeholder"
            :disabled="disabled"
            class="h-auto py-2 pr-10 font-sans tracking-normal"
            @input="handleInput"
        />
        <Button
            type="button"
            variant="ghost"
            size="icon"
            :disabled="disabled"
            :aria-label="showPassword ? '隐藏密码' : '显示密码'"
            :aria-pressed="showPassword"
            class="absolute top-1/2 right-2 h-7 w-7 -translate-y-1/2 rounded-md p-0 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 disabled:cursor-not-allowed disabled:opacity-50"
            @click="togglePasswordVisibility"
        >
            <AppIcon :name="visibilityIcon" class="h-5 w-5" />
        </Button>
    </div>
</template>
