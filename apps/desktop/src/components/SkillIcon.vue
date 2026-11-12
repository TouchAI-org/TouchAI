<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import { useId } from 'vue';

    withDefaults(defineProps<{ size?: '2xs' | 'xs' | 'sm' | 'md' | 'lg'; accent?: boolean }>(), {
        size: 'md',
        accent: false,
    });
    const gradientId = `skill-icon-${useId()}`;
    const sizes = {
        '2xs': 'h-4 w-4 rounded',
        xs: 'h-5 w-5 rounded',
        sm: 'h-6 w-6 rounded',
        md: 'h-8 w-8 rounded-md',
        lg: 'h-10 w-10 rounded-md',
    };
    const glyphSizes = {
        '2xs': 'h-3 w-3',
        xs: 'h-3.5 w-3.5',
        sm: 'h-3.5 w-3.5',
        md: 'h-4 w-4',
        lg: 'h-5 w-5',
    };
</script>

<template>
    <span
        aria-hidden="true"
        class="inline-flex shrink-0 items-center justify-center"
        :class="[
            sizes[size],
            accent
                ? 'bg-linear-to-br from-skill-start/10 to-skill-end/10 text-skill-start'
                : 'border border-search-border bg-search-hover text-search-text',
        ]"
    >
        <svg v-if="accent" class="absolute h-0 w-0" focusable="false">
            <defs>
                <linearGradient :id="gradientId" x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0" stop-color="var(--color-skill-start)" />
                    <stop offset="1" stop-color="var(--color-skill-end)" />
                </linearGradient>
            </defs>
        </svg>
        <AppIcon
            name="skill"
            :class="glyphSizes[size]"
            :style="accent ? { stroke: `url(#${gradientId})` } : undefined"
        />
    </span>
</template>
