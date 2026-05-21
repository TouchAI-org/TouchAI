<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    defineOptions({
        name: 'UiSonner',
    });

    import { Toaster } from 'vue-sonner';
</script>

<template>
    <Toaster
        position="top-center"
        :duration="3000"
        :close-button="true"
        :toast-options="{
            class: 'rounded-lg border border-gray-200 bg-white px-4 py-3 shadow-sm font-serif text-sm text-gray-900',
            classes: {
                closeButton:
                    'rounded p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600',
                success: 'text-green-500',
                error: 'text-red-500',
                warning: 'text-amber-500',
                info: 'text-blue-500',
            },
        }"
    />
</template>
