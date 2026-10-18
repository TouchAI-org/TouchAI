<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import { computed } from 'vue';

    import { getToolLogStatusClass, getToolLogStatusText } from './toolLogStatus';

    interface Props {
        status: string;
        subtle?: boolean;
    }

    const props = defineProps<Props>();

    const statusClass = computed(() => getToolLogStatusClass(props.status));
    const statusText = computed(() => getToolLogStatusText(props.status));
</script>

<template>
    <span
        :class="[
            'inline-flex items-center gap-1.5 rounded-[5px] px-2 py-0.5 text-xs whitespace-nowrap',
            subtle ? 'bg-neutral-100 text-neutral-600' : statusClass,
        ]"
    >
        <span
            v-if="subtle"
            :class="[
                'h-1.5 w-1.5 rounded-full',
                status === 'success' ? 'bg-emerald-600' : 'bg-neutral-400',
            ]"
            aria-hidden="true"
        />
        {{ statusText }}
    </span>
</template>
