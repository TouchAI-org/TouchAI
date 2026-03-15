<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<template>
    <div class="flex items-center justify-end gap-1">
        <button
            class="pin-button flex h-7 w-7 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
            aria-label="Pin conversation panel"
            data-tauri-drag-region="false"
            data-drag-exclude="true"
            @mousedown.stop
            @click.stop="togglePinned"
        >
            <SvgIcon
                name="pin"
                class="h-4 w-4 transition-transform duration-200 ease-in-out"
                :class="isPinned ? 'rotate-[-30deg]' : 'rotate-0'"
            />
        </button>
    </div>
</template>

<script setup lang="ts">
    import SvgIcon from '@components/SvgIcon.vue';

    interface Props {
        isPinned: boolean;
    }

    const props = defineProps<Props>();

    const emit = defineEmits<{
        pinChange: [isPinned: boolean];
    }>();

    function togglePinned() {
        emit('pinChange', !props.isPinned);
    }
</script>
