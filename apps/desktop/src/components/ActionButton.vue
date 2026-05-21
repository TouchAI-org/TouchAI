<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<template>
    <button
        class="flex h-7 w-7 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
        :aria-label="ariaLabel"
        @click.stop="handler"
    >
        <AppIcon :name="icon" class="h-4 w-4" />
    </button>
</template>

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import type { AppIconName } from '@components/appIconMap';

    interface Props {
        icon: AppIconName;
        handler: () => void;
        ariaLabel?: string;
    }

    withDefaults(defineProps<Props>(), {
        ariaLabel: '',
    });
</script>
