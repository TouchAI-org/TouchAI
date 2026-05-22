<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import { computed } from 'vue';

    import { getToolLogStatusClass, getToolLogStatusText } from './toolLogStatus';

    interface Props {
        status: string;
    }

    const props = defineProps<Props>();

    const statusClass = computed(() => getToolLogStatusClass(props.status));
    const statusText = computed(() => getToolLogStatusText(props.status));
</script>

<template>
    <span :class="['rounded px-2 py-0.5 font-serif text-xs', statusClass]">
        {{ statusText }}
    </span>
</template>
