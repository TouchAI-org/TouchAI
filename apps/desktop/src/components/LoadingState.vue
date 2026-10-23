<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import { t } from '@/i18n';

    import CursorLoadingIndicator from './CursorLoadingIndicator.vue';

    interface Props {
        message?: string;
        fill?: 'screen' | 'full' | 'min';
        variant?: 'spinner' | 'brand';
    }

    const props = withDefaults(defineProps<Props>(), {
        fill: 'full',
        message: undefined,
        variant: 'spinner',
    });
</script>

<template>
    <div
        role="status"
        :aria-label="props.message || t('common.loading')"
        :class="[
            'flex items-center justify-center p-6',
            props.fill === 'screen'
                ? 'h-screen w-screen bg-canvas'
                : props.fill === 'min'
                  ? 'min-h-full w-full bg-white'
                  : 'h-full w-full bg-white',
        ]"
    >
        <CursorLoadingIndicator v-if="props.variant === 'brand'" />
        <div
            v-else
            aria-hidden="true"
            class="h-10 w-10 animate-spin rounded-full border-3 border-primary-100 border-t-primary-500"
        ></div>
    </div>
</template>
