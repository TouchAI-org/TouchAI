<!--
  - Copyright (c) 2026. Qian Cheng. Licensed under GPL v3
  -->

<template>
    <button
        type="button"
        :data-testid="dataTestid"
        :data-result-name="dataResultName"
        :class="[
            'quick-search-list-item grid w-full cursor-pointer items-center px-2 outline-none',
            highlighted ? 'bg-primary-100 rounded-lg' : 'rounded-lg hover:bg-gray-100',
        ]"
        :style="{
            height: `${rowHeight}px`,
            gridTemplateColumns: 'var(--qs-icon-size) var(--qs-name-width) 1fr',
            gap: '8px',
        }"
        @click="$emit('click')"
        @contextmenu.prevent="$emit('contextmenu', $event)"
    >
        <div class="flex h-4 w-4 items-center justify-center">
            <img v-if="iconSrc" :src="iconSrc" :alt="name" class="h-4 w-4 rounded object-contain" />
            <div v-else class="h-4 w-4 rounded-sm bg-gray-200"></div>
        </div>
        <span class="truncate text-left text-[13px] leading-4 text-gray-700">
            <span
                v-for="(segment, i) in nameSegments"
                :key="i"
                :class="segment.matched ? 'quick-search-name-match' : ''"
            >
                {{ segment.text }}
            </span>
        </span>
        <span v-if="path" class="truncate text-left text-[12px] leading-4 text-gray-400">
            {{ path }}
        </span>
    </button>
</template>

<script setup lang="ts">
    import type { NameSegment } from './utils/quickSearchHighlight';

    defineOptions({
        name: 'QuickSearchListItem',
    });

    withDefaults(
        defineProps<{
            name: string;
            path: string;
            iconSrc: string | undefined;
            nameSegments: NameSegment[];
            highlighted: boolean;
            rowHeight?: number;
            dataTestid?: string;
            dataResultName?: string;
        }>(),
        {
            dataResultName: undefined,
            dataTestid: undefined,
            rowHeight: 40,
        }
    );

    defineEmits<{
        click: [];
        contextmenu: [event: MouseEvent];
    }>();
</script>
