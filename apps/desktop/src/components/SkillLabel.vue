<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';

    defineProps<{ name: string; accent?: boolean }>();
</script>

<template>
    <span
        class="inline-flex max-w-full min-w-0 items-baseline gap-1 align-baseline"
        :class="{ 'text-skill-reference': accent }"
        data-no-i18n="true"
        translate="no"
    >
        <AppIcon
            name="skill"
            class="h-4 w-4 shrink-0 self-center"
            :class="{ 'translate-y-px': accent }"
            aria-hidden="true"
        />
        <span class="min-w-0 break-words">
            {{ name }}
        </span>
    </span>
</template>
