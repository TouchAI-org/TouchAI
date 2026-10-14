<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->
<script setup lang="ts">
    import { ref, watch } from 'vue';

    const props = withDefaults(defineProps<{ open: boolean; lazy?: boolean }>(), { lazy: false });
    // Mount expensive details once; keep state during interrupted closes.
    const visited = ref(props.open || !props.lazy);
    watch(
        () => props.open,
        (open) => {
            if (open) visited.value = true;
        },
        { flush: 'sync' }
    );
</script>

<template>
    <div class="t-acc-panel" :data-open="open" :aria-hidden="!open" :inert="!open">
        <div class="t-acc-panel-inner">
            <slot v-if="visited" />
        </div>
    </div>
</template>
