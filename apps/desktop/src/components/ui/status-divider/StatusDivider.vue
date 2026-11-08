<!-- Copyright (c) 2026. Qian Cheng. Licensed under GPL v3 -->

<script setup lang="ts">
    import AppIcon from '@/components/AppIcon.vue';
    import type { AppIconName } from '@/components/appIconMap';

    defineProps<{ label: string; icon: AppIconName; loading?: boolean }>();
</script>

<template>
    <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        :aria-busy="!!loading"
        class="flex w-full items-center gap-3 py-3 font-serif text-sm font-medium text-muted-foreground/60 contrast-more:text-muted-foreground"
    >
        <span
            aria-hidden="true"
            class="h-px min-w-0 flex-1 scale-y-50 bg-border contrast-more:scale-y-100"
        />
        <span class="flex min-w-0 items-center gap-2">
            <AppIcon :name="icon" aria-hidden="true" class="size-3.5 shrink-0" />
            <span class="min-w-0 text-center" :class="{ 't-text-shimmer': loading }">
                {{ label }}
            </span>
        </span>
        <span
            aria-hidden="true"
            class="h-px min-w-0 flex-1 scale-y-50 bg-border contrast-more:scale-y-100"
        />
    </div>
</template>

<style scoped>
    .t-text-shimmer {
        --text-shimmer-highlight: var(--color-muted-foreground);
    }
</style>
