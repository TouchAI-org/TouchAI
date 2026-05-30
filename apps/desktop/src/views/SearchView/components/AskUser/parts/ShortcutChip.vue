<!--
  Ported from registry/default/ask-user-questions.tsx (ShortcutChip subcomponent).
-->

<template>
    <kbd
        aria-hidden
        :class="[
            'inline-flex h-[18px] min-w-[18px] items-center justify-center gap-0.5 px-1 text-[11px] leading-none tracking-wide',
            tone === 'inverted'
                ? 'bg-foreground text-background'
                : 'bg-foreground/10 text-muted-foreground',
            shape.bg,
        ]"
        style="font-family: var(--font-sans, system-ui)"
    >
        <slot />
    </kbd>
</template>

<script setup lang="ts">
    import { shape } from '../lib/shape';

    interface Props {
        tone?: 'muted' | 'inverted';
    }

    withDefaults(defineProps<Props>(), { tone: 'muted' });
</script>
