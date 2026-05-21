<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    interface Props {
        message: string;
        fill?: 'full' | 'min';
    }

    const props = withDefaults(defineProps<Props>(), {
        fill: 'full',
    });
</script>

<template>
    <div
        :class="[
            'flex items-center justify-center p-6',
            props.fill === 'min' ? 'min-h-full' : 'h-full',
        ]"
    >
        <div class="text-center">
            <div
                class="border-primary-100 border-t-primary-500 mx-auto h-10 w-10 animate-spin rounded-full border-3"
            ></div>
            <p class="mt-4 font-serif text-sm text-gray-500">{{ props.message }}</p>
        </div>
    </div>
</template>
