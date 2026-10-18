<!-- Copyright (c) 2026. Qian Cheng. Licensed under GPL v3 -->

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import type { AppIconName } from '@components/appIconMap';

    withDefaults(
        defineProps<{
            title: string;
            description?: string;
            icon?: AppIconName;
            /** Compact only reduces surrounding whitespace. */
            size?: 'default' | 'compact';
        }>(),
        {
            description: undefined,
            icon: 'inbox',
            size: 'default',
        }
    );
</script>

<template>
    <div
        role="status"
        aria-live="polite"
        data-testid="empty-state"
        :class="[
            'flex min-w-0 flex-col items-center justify-center px-6 text-center',
            size === 'compact' ? 'py-5' : 'py-12',
        ]"
    >
        <span
            class="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-neutral-100 text-neutral-950"
            aria-hidden="true"
        >
            <AppIcon :name="icon" class="h-5 w-5" />
        </span>
        <p class="mt-6 max-w-full text-base font-medium break-words text-neutral-950">
            {{ title }}
        </p>
        <p
            v-if="description || $slots.description"
            class="mt-3 max-w-md text-sm leading-6 break-words text-neutral-500"
        >
            <slot name="description">{{ description }}</slot>
        </p>
        <div v-if="$slots.actions" class="mt-6 flex flex-wrap items-center justify-center gap-2">
            <slot name="actions" />
        </div>
    </div>
</template>
